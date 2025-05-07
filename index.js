#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import chalk from "chalk";
import yaml from "js-yaml";
import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import ora from "ora";

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

// 웹 서버 초기화
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOAD_DIR));

// 파일 업로드 및 확장 프로그램 확인 엔드포인트
app.post('/api/upload', upload.single('extensionsFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "extensions.yml 파일을 업로드해주세요."
      });
    }

    const extensionsYaml = fs.readFileSync(req.file.path, "utf8");
    const extensions = yaml.load(extensionsYaml);

    if (!extensions.enabled || !Array.isArray(extensions.enabled)) {
      return res.status(400).json({
        success: false,
        message: "유효한 확장 프로그램 목록을 찾을 수 없습니다."
      });
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

    console.log("Open VSX에서 확장 프로그램 확인 중...");

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

    console.log(
      `확인 완료: ${results.available.length}개 사용 가능, ${results.unavailable.length}개 사용 불가`
    );

    // 결과를 JSON 파일로 저장
    fs.writeFileSync(
      path.join(__dirname, "results.json"),
      JSON.stringify(results, null, 2)
    );
    console.log("결과가 results.json 파일에 저장되었습니다.");

    // 업로드된 파일 삭제
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      results: results
    });
  } catch (error) {
    console.error("오류 발생:", error.message);
    res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
      error: error.message
    });
  }
});

// ID로 확장 프로그램 다운로드 엔드포인트
app.get("/api/download/:id", async (req, res) => {
  const extensionId = req.params.id;
  await handleExtensionDownload(extensionId, res);
});

async function downloadMissingExtensions(unavailableExtensions) {
  console.log(chalk.blue("\n사용할 수 없는 확장 프로그램 다운로드 중..."));

  for (const extension of unavailableExtensions) {
    const spinner = ora(`${extension.id} 다운로드 중...`).start();

    try {
      // 파일 이름을 확장 프로그램 ID 기반으로 생성
      const fileName = `${extension.id.replace(/\./g, '-')}.vsix`;
      await downloadFromMarketplace(extension.id, null, fileName);
      spinner.succeed(`${extension.id} 다운로드 완료`);
    } catch (error) {
      spinner.fail(`${extension.id} 다운로드 실패: ${error.message}`);
    }
  }
}

async function downloadFromMarketplace(extensionId, version = null, customFileName = null) {
  console.log(chalk.blue(`VSCode Marketplace에서 ${extensionId} 확장 프로그램 다운로드 시도 중...`));
  
  // 확장 프로그램 ID를 게시자와 이름으로 분리
  const [publisher, name] = extensionId.split('.');
  
  if (!publisher || !name) {
    throw new Error(`유효하지 않은 확장 프로그램 ID 형식: ${extensionId}`);
  }
  
  // 파일 이름이 지정되지 않은 경우 기본 파일 이름 생성
  if (!customFileName) {
    customFileName = `${extensionId.replace(/\./g, '-')}.vsix`;
  }
  
  // 마켓플레이스 URL 생성
  const marketplaceUrl = `${VSCODE_MARKETPLACE_URL}?itemName=${extensionId}`;
  
  // 직접 다운로드 URL 생성
  let directDownloadUrl;
  let versionInfo = version;
  // 파일 이름을 확장 프로그램 ID 기반으로 생성 (점을 하이픈으로 변경) 또는 사용자 지정 이름 사용
  const fileName = customFileName || `${extensionId.replace(/\./g, '-')}.vsix`;
  const outputPath = path.join(DOWNLOAD_DIR, fileName);
  
  try {
    // 버전 정보가 없는 경우 마켓플레이스에서 최신 버전 정보 가져오기 시도
    if (!version) {
      try {
        console.log(chalk.blue(`마켓플레이스에서 ${extensionId} 버전 정보 확인 중...`));
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
      fileName: fileName, // 파일 이름 정보 추가
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
    downloads = downloads.filter((item) => item.id !== extensionId);
    downloads.push(downloadInfo);

    fs.writeFileSync(downloadsJson, JSON.stringify(downloads, null, 2));

    return {
      marketplaceUrl,
      directDownloadUrl,
      fileName: fileName // 파일 이름 정보 반환
    };
  } catch (error) {
    console.error(chalk.red("마켓플레이스 다운로드 정보 생성 중 오류:"), error.message);
    throw error;
  }
}

async function downloadExtension(extensionId, downloadUrl, customFileName = null) {
  const spinner = ora(`${extensionId} 확장 프로그램 다운로드 중...`).start();
  
  try {
    const response = await axios({
      method: 'get',
      url: downloadUrl,
      responseType: 'stream'
    });
    
    // 다운로드 디렉토리가 없으면 생성
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    
    // 파일 이름을 확장 프로그램 ID 또는 사용자 지정 이름으로 설정
    const fileName = customFileName || `${extensionId.replace(/\./g, '-')}.vsix`;
    const outputPath = path.join(DOWNLOAD_DIR, fileName);
    const writer = fs.createWriteStream(outputPath);
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        spinner.succeed(`${extensionId} 확장 프로그램 다운로드 완료`);
        resolve(outputPath);
      });
      writer.on('error', (err) => {
        spinner.fail(`${extensionId} 확장 프로그램 다운로드 실패`);
        reject(err);
      });
    });
  } catch (error) {
    spinner.fail(`${extensionId} 확장 프로그램 다운로드 실패`);
    throw error;
  }
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

// 확장 프로그램 다운로드 처리 통합 함수
async function handleExtensionDownload(extensionId, res, uuid = null) {
  try {
    // 파일 이름을 ID 또는 UUID 기반으로 생성
    const fileName = uuid ? 
      `${uuid}.vsix` : 
      `${extensionId.replace(/\./g, '-')}.vsix`;
    
    try {
      // VSCode Marketplace에서 다운로드 시도
      const downloadInfo = await downloadFromMarketplace(extensionId, null, fileName);
      
      // 마켓플레이스 다운로드는 수동 다운로드가 필요하므로 success를 true로 설정하고 requiresManualDownload 플래그 추가
      return res.json({ 
        success: true, 
        source: 'marketplace', 
        marketplaceUrl: downloadInfo.marketplaceUrl,
        directDownloadUrl: downloadInfo.directDownloadUrl,
        fileName: fileName,
        requiresManualDownload: true, 
        message: 'VSCode Marketplace에서 수동으로 다운로드해야 합니다. 직접 다운로드 URL도 사용할 수 있습니다.'
      });
    } catch (marketplaceError) {
      return res.status(404).json({
        success: false,
        message: `확장 프로그램 ${extensionId}를 찾을 수 없습니다.`,
        error: marketplaceError.message
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
      error: error.message
    });
  }
}

// UUID로 확장 프로그램 다운로드 엔드포인트
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
    // UUID를 파일 이름으로 전달
    await handleExtensionDownload(extensionId, res, uuid);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
      error: error.message
    });
  }
});

// 결과 조회 엔드포인트
app.get("/api/extensions", (req, res) => {
  try {
    const resultsPath = path.join(__dirname, "results.json");
    if (fs.existsSync(resultsPath)) {
      const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      res.json(results);
    } else {
      res.json({
        available: [],
        unavailable: []
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "결과를 불러오는 중 오류가 발생했습니다.",
      error: error.message
    });
  }
});



// 서버 시작
app.listen(PORT, () => {
  console.log(
    chalk.blue(
      `웹 인터페이스가 http://localhost:${PORT} 에서 실행 중입니다.`
    )
  );
});
