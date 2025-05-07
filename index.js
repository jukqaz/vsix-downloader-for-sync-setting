#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import chalk from "chalk";
import { Command } from "commander";
import yaml from "js-yaml";
import ora from "ora";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPEN_VSX_API = "https://open-vsx.org/api";
const VSCODE_MARKETPLACE_API =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const VSCODE_MARKETPLACE_URL = "https://marketplace.visualstudio.com/items";
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

// 다운로드 디렉토리가 없으면 생성
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const program = new Command();

program
  .name("vsx-extension-finder")
  .description(
    "VSCode 확장 프로그램을 Open VSX에서 검색하고 VSIX 파일을 다운로드하는 도구"
  )
  .version("1.0.0");

program
  .command("check")
  .description(
    "YAML 파일에서 확장 프로그램 목록을 확인하고 Open VSX에서 사용 가능한지 확인합니다"
  )
  .argument("<file>", "extensions.yml 파일 경로")
  .option(
    "-d, --download",
    "사용할 수 없는 확장 프로그램의 VSIX 파일을 다운로드합니다"
  )
  .action(async (file, options) => {
    try {
      const extensionsYaml = fs.readFileSync(file, "utf8");
      const extensions = yaml.load(extensionsYaml);

      if (!extensions.enabled || !Array.isArray(extensions.enabled)) {
        console.error(
          chalk.red("유효한 확장 프로그램 목록을 찾을 수 없습니다.")
        );
        return;
      }

      console.log(
        chalk.blue(
          `총 ${extensions.enabled.length}개의 확장 프로그램을 확인합니다...`
        )
      );

      const results = {
        available: [],
        unavailable: [],
      };

      const spinner = ora("Open VSX에서 확장 프로그램 확인 중...").start();

      for (const extension of extensions.enabled) {
        if (!extension.id) continue;

        try {
          const response = await axios.get(
            `${OPEN_VSX_API}/${extension.id.replace(".", "/")}`
          );
          results.available.push({
            id: extension.id,
            uuid: extension.uuid,
            url: response.data.downloadUrl,
          });
        } catch (error) {
          results.unavailable.push({
            id: extension.id,
            uuid: extension.uuid,
          });
        }
      }

      spinner.succeed(
        `확인 완료: ${results.available.length}개 사용 가능, ${results.unavailable.length}개 사용 불가`
      );

      console.log(chalk.green("\n✅ Open VSX에서 사용 가능한 확장 프로그램:"));
      results.available.forEach((ext) => console.log(`  - ${ext.id}`));

      console.log(
        chalk.yellow("\n❌ Open VSX에서 사용할 수 없는 확장 프로그램:")
      );
      results.unavailable.forEach((ext) => console.log(`  - ${ext.id}`));

      // 결과를 JSON 파일로 저장
      fs.writeFileSync(
        path.join(__dirname, "results.json"),
        JSON.stringify(results, null, 2)
      );
      console.log(chalk.blue("\n결과가 results.json 파일에 저장되었습니다."));

      if (options.download && results.unavailable.length > 0) {
        await downloadMissingExtensions(results.unavailable);
      }

      // 웹 서버 시작
      startWebServer(results);
    } catch (error) {
      console.error(chalk.red("오류 발생:"), error.message);
    }
  });

program
  .command("download")
  .description("특정 확장 프로그램의 VSIX 파일을 다운로드합니다")
  .argument("<extension-id>", "확장 프로그램 ID (예: ms-python.python)")
  .action(async (extensionId) => {
    try {
      const spinner = ora(
        `${extensionId} 확장 프로그램 다운로드 중...`
      ).start();

      try {
        // 먼저 Open VSX에서 확인
        const response = await axios.get(
          `${OPEN_VSX_API}/${extensionId.replace(".", "/")}`
        );
        const downloadUrl = response.data.downloadUrl;

        await downloadExtension(extensionId, downloadUrl);
        spinner.succeed(
          `${extensionId} 확장 프로그램이 Open VSX에서 다운로드되었습니다.`
        );
      } catch (error) {
        spinner.warn(
          `${extensionId} 확장 프로그램을 Open VSX에서 찾을 수 없습니다. VSCode Marketplace에서 시도합니다...`
        );

        try {
          await downloadFromMarketplace(extensionId);
          spinner.succeed(
            `${extensionId} 확장 프로그램이 VSCode Marketplace에서 다운로드되었습니다.`
          );
        } catch (marketplaceError) {
          spinner.fail(
            `${extensionId} 확장 프로그램을 다운로드할 수 없습니다.`
          );
          console.error(chalk.red("오류 발생:"), marketplaceError.message);
        }
      }
    } catch (error) {
      console.error(chalk.red("오류 발생:"), error.message);
    }
  });

async function downloadMissingExtensions(unavailableExtensions) {
  console.log(chalk.blue("\n사용할 수 없는 확장 프로그램 다운로드 중..."));

  for (const extension of unavailableExtensions) {
    const spinner = ora(`${extension.id} 다운로드 중...`).start();

    try {
      await downloadFromMarketplace(extension.id);
      spinner.succeed(`${extension.id} 다운로드 완료`);
    } catch (error) {
      spinner.fail(`${extension.id} 다운로드 실패: ${error.message}`);
    }
  }
}

async function downloadFromMarketplace(extensionId, version = null) {
  const [publisher, name] = extensionId.split(".");

  if (!publisher || !name) {
    throw new Error(
      '유효하지 않은 확장 프로그램 ID 형식입니다. "publisher.name" 형식이어야 합니다.'
    );
  }

  // 마켓플레이스 웹 페이지 URL
  const marketplaceUrl = `${VSCODE_MARKETPLACE_URL}?itemName=${extensionId}`;
  let directDownloadUrl = null;
  let vsixFilename = `${extensionId}.vsix`;
  let outputPath = path.join(DOWNLOAD_DIR, vsixFilename);
  let versionInfo = version;

  try {
    // 버전 정보가 없는 경우 마켓플레이스에서 최신 버전 정보 가져오기 시도
    if (!version) {
      try {
        console.log(chalk.blue(`마켓플레이스에서 ${extensionId} 버전 정보 확인 중...`));
        // 마켓플레이스 페이지에서 버전 정보를 가져오는 로직을 추가할 수 있지만,
        // 현재는 직접 다운로드 URL 형식만 제공
      } catch (error) {
        console.log(chalk.yellow(`버전 정보를 가져올 수 없습니다. 직접 다운로드 URL만 제공합니다.`));
      }
    }

    // 블로그에서 설명한 직접 다운로드 URL 형식 사용
    // https://${publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/${publisher}/extension/${name}/${version}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage
    directDownloadUrl = `https://${publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/${publisher}/extension/${name}/${versionInfo || 'latest'}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage`;

    // 다운로드 정보를 JSON 파일에 저장
    const downloadInfo = {
      id: extensionId,
      marketplaceUrl,
      directDownloadUrl,
      downloadPath: outputPath,
      version: versionInfo,
      timestamp: new Date().toISOString(),
      success: false, // 초기에는 다운로드 성공 여부를 false로 설정
    };

    const downloadsJson = path.join(__dirname, "downloads.json");
    let downloads = [];

    if (fs.existsSync(downloadsJson)) {
      downloads = JSON.parse(fs.readFileSync(downloadsJson, "utf8"));
    }

    // 중복 항목 확인 및 제거
    const existingIndex = downloads.findIndex((item) => item.id === extensionId);
    if (existingIndex !== -1) {
      // 기존 항목 제거
      downloads.splice(existingIndex, 1);
    }

    // 새 항목 추가
    downloads.push(downloadInfo);
    fs.writeFileSync(downloadsJson, JSON.stringify(downloads, null, 2));

    return downloadInfo;
  } catch (error) {
    console.error(chalk.red(`마켓플레이스 다운로드 URL 생성 중 오류: ${error.message}`));
    throw error;
  }
}

async function downloadExtension(extensionId, downloadUrl) {
  const vsixFilename = `${extensionId}.vsix`;
  const outputPath = path.join(DOWNLOAD_DIR, vsixFilename);

  const response = await axios({
    method: "GET",
    url: downloadUrl,
    responseType: "stream",
  });

  const writer = fs.createWriteStream(outputPath);

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);

    writer.on("finish", () => {
      console.log(chalk.green(`${vsixFilename} 파일이 다운로드되었습니다.`));
      // 다운로드 성공 정보 업데이트
      updateDownloadStatus(extensionId, true);
      resolve(outputPath);
    });

    writer.on("error", (err) => {
      // 다운로드 실패 정보 업데이트
      updateDownloadStatus(extensionId, false);
      reject(err);
    });
  });
}

// 다운로드 상태 업데이트 함수
function updateDownloadStatus(extensionId, success) {
  const downloadsJson = path.join(__dirname, "downloads.json");

  if (fs.existsSync(downloadsJson)) {
    let downloads = JSON.parse(fs.readFileSync(downloadsJson, "utf8"));

    // 해당 ID의 확장 프로그램 찾기
    const index = downloads.findIndex((item) => item.id === extensionId);

    if (index !== -1) {
      // 성공 상태 업데이트
      downloads[index].success = success;
      downloads[index].timestamp = new Date().toISOString();

      fs.writeFileSync(downloadsJson, JSON.stringify(downloads, null, 2));
    }
  }
}

function startWebServer(results) {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.static(path.join(__dirname, "public")));
  app.use("/downloads", express.static(DOWNLOAD_DIR));

  app.get("/api/extensions", (req, res) => {
    res.json(results);
  });

  // ID로 확장 프로그램 조회
  app.get("/api/download/:id", async (req, res) => {
    const extensionId = req.params.id;

    try {
      // 먼저 Open VSX에서 확인
      try {
        const response = await axios.get(
          `${OPEN_VSX_API}/${extensionId.replace(".", "/")}`
        );
        const downloadUrl = response.data.downloadUrl;

        const outputPath = await downloadExtension(extensionId, downloadUrl);

        // 다운로드 성공 정보 업데이트
        updateDownloadStatus(extensionId, true);

        res.json({
          success: true,
          source: "open-vsx",
          path: `/downloads/${path.basename(outputPath)}`
        });
      } catch (error) {
        // Open VSX에서 찾을 수 없는 경우 VSCode Marketplace에서 시도
        try {
          const downloadInfo = await downloadFromMarketplace(extensionId);
          
          // 마켓플레이스 다운로드는 수동 다운로드가 필요하므로 success를 true로 설정하고 requiresManualDownload 플래그 추가
          res.json({ 
            success: true, 
            source: 'marketplace', 
            marketplaceUrl: downloadInfo.marketplaceUrl,
            directDownloadUrl: downloadInfo.directDownloadUrl,
            requiresManualDownload: true, 
            message: 'VSCode Marketplace에서 수동으로 다운로드해야 합니다. 직접 다운로드 URL도 사용할 수 있습니다.'
          });
        } catch (marketplaceError) {
          res.status(404).json({
            success: false,
            message: `확장 프로그램 ${extensionId}를 찾을 수 없습니다.`,
            error: marketplaceError.message
          });
        }
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "서버 오류가 발생했습니다.",
        error: error.message
      });
    }
  });

  // UUID로 확장 프로그램 조회
  app.get("/api/download-by-uuid/:uuid", async (req, res) => {
    const uuid = req.params.uuid;
    
    try {
      // results.json 파일에서 UUID에 해당하는 확장 프로그램 ID 찾기
      const resultsPath = path.join(__dirname, "results.json");
      let extensionId = null;
      
      if (fs.existsSync(resultsPath)) {
        const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
        const allExtensions = [...results.available, ...results.unavailable];
        const extension = allExtensions.find((ext) => ext.uuid === uuid);
        
        if (extension) {
          extensionId = extension.id;
        }
      }
      
      if (!extensionId) {
        return res.status(404).json({
          success: false,
          message: `UUID ${uuid}에 해당하는 확장 프로그램을 찾을 수 없습니다.`
        });
      }
      
      // ID를 사용하여 다운로드 진행
      try {
        // 먼저 Open VSX에서 확인
        const response = await axios.get(
          `${OPEN_VSX_API}/${extensionId.replace(".", "/")}`
        );
        const downloadUrl = response.data.downloadUrl;
        
        const outputPath = await downloadExtension(extensionId, downloadUrl);
        
        // 다운로드 성공 정보 업데이트
        updateDownloadStatus(extensionId, true);
        
        res.json({
          success: true,
          source: "open-vsx",
          path: `/downloads/${path.basename(outputPath)}`
        });
      } catch (error) {
        // Open VSX에서 찾을 수 없는 경우 VSCode Marketplace에서 시도
        try {
          const downloadInfo = await downloadFromMarketplace(extensionId);
          
          // 마켓플레이스 다운로드는 수동 다운로드가 필요하므로 success를 true로 설정하고 requiresManualDownload 플래그 추가
          res.json({ 
            success: true, 
            source: 'marketplace', 
            marketplaceUrl: downloadInfo.marketplaceUrl,
            directDownloadUrl: downloadInfo.directDownloadUrl,
            requiresManualDownload: true, 
            message: 'VSCode Marketplace에서 수동으로 다운로드해야 합니다. 직접 다운로드 URL도 사용할 수 있습니다.'
          });
        } catch (marketplaceError) {
          res.status(404).json({
            success: false,
            message: `확장 프로그램 ${extensionId}를 찾을 수 없습니다.`,
            error: marketplaceError.message
          });
        }
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "서버 오류가 발생했습니다.",
        error: error.message
      });
    }
  });

  app.listen(PORT, () => {
    console.log(
      chalk.blue(
        `\n웹 인터페이스가 http://localhost:${PORT} 에서 실행 중입니다.`
      )
    );
  });
}

// UUID로 다운로드하는 명령어 추가
program
  .command("download-by-uuid")
  .description(
    "UUID를 사용하여 특정 확장 프로그램의 VSIX 파일을 다운로드합니다"
  )
  .argument("<uuid>", "확장 프로그램 UUID")
  .option("-f, --file <file>", "extensions.yml 파일 경로 (필요한 경우)")
  .action(async (uuid, options) => {
    try {
      let extensionId = null;

      // results.json 파일이 있는지 확인
      const resultsPath = path.join(__dirname, "results.json");

      if (fs.existsSync(resultsPath)) {
        // results.json 파일에서 UUID에 해당하는 확장 프로그램 ID 찾기
        const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
        const allExtensions = [...results.available, ...results.unavailable];
        const extension = allExtensions.find((ext) => ext.uuid === uuid);

        if (extension) {
          extensionId = extension.id;
        }
      }

      // results.json에서 찾지 못했거나 파일이 없는 경우, 제공된 extensions.yml 파일에서 찾기
      if (!extensionId && options.file) {
        const extensionsYaml = fs.readFileSync(options.file, "utf8");
        const extensions = yaml.load(extensionsYaml);

        if (extensions.enabled && Array.isArray(extensions.enabled)) {
          const extension = extensions.enabled.find((ext) => ext.uuid === uuid);
          if (extension) {
            extensionId = extension.id;
          }
        }
      }

      if (!extensionId) {
        console.error(
          chalk.red(`UUID ${uuid}에 해당하는 확장 프로그램을 찾을 수 없습니다.`)
        );
        console.log(
          chalk.yellow(
            "힌트: -f 옵션으로 extensions.yml 파일 경로를 지정하거나, 먼저 check 명령어를 실행하세요."
          )
        );
        return;
      }

      // 이제 ID를 사용하여 다운로드 진행
      const spinner = ora(
        `${extensionId} (UUID: ${uuid}) 확장 프로그램 다운로드 중...`
      ).start();

      try {
        // 먼저 Open VSX에서 확인
        const response = await axios.get(
          `${OPEN_VSX_API}/${extensionId.replace(".", "/")}`
        );
        const downloadUrl = response.data.downloadUrl;

        await downloadExtension(extensionId, downloadUrl);
        spinner.succeed(
          `${extensionId} 확장 프로그램이 Open VSX에서 다운로드되었습니다.`
        );
      } catch (error) {
        spinner.warn(
          `${extensionId} 확장 프로그램을 Open VSX에서 찾을 수 없습니다. VSCode Marketplace에서 시도합니다...`
        );

        try {
          await downloadFromMarketplace(extensionId);
          spinner.succeed(
            `${extensionId} 확장 프로그램이 VSCode Marketplace에서 다운로드되었습니다.`
          );
        } catch (marketplaceError) {
          spinner.fail(
            `${extensionId} 확장 프로그램을 다운로드할 수 없습니다.`
          );
          console.error(chalk.red("오류 발생:"), marketplaceError.message);
        }
      }
    } catch (error) {
      console.error(chalk.red("오류 발생:"), error.message);
    }
  });

program.parse();
