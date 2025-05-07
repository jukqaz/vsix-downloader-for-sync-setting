use std::path::{Path, PathBuf};
use std::fs::{self, create_dir_all, File};
use std::io::Write;

use anyhow::{Result, Context, anyhow};
use chrono::Utc;
use clap::{Parser, Subcommand};
use colored::Colorize;
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;

const OPEN_VSX_API: &str = "https://open-vsx.org/api";
const VSCODE_MARKETPLACE_URL: &str = "https://marketplace.visualstudio.com/items";

#[derive(Parser)]
#[command(author, version, about = "VSCode 확장 프로그램을 Open VSX에서 검색하고 VSCode Marketplace에서 다운로드하는 도구")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// YAML 파일에서 확장 프로그램을 확인하고 VSCode Marketplace에서 다운로드합니다
    Sync {
        /// 확장 프로그램 목록이 포함된 YAML 파일 경로
        #[arg(short, long)]
        file: PathBuf,
        
        /// 결과를 저장할 JSON 파일 경로 (기본값: results.json)
        #[arg(short = 'r', long, default_value = "results.json")]
        output: PathBuf,
        
        /// 다운로드 디렉토리 (기본값: ./downloads)
        #[arg(short, long, default_value = "downloads")]
        output_dir: PathBuf,
        
        /// 확인 없이 자동으로 다운로드 실행
        #[arg(short, long, default_value_t = false)]
        auto_download: bool,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct Extensions {
    enabled: Option<Vec<Extension>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Extension {
    id: String,
    uuid: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Results {
    available: Vec<AvailableExtension>,
    unavailable: Vec<UnavailableExtension>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AvailableExtension {
    id: String,
    uuid: Option<String>,
    url: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct UnavailableExtension {
    id: String,
    uuid: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DownloadInfo {
    id: String,
    marketplace_url: String,
    direct_download_url: String,
    download_path: String,
    file_name: String,
    version: Option<String>,
    timestamp: String,
    success: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match &cli.command {
        Commands::Sync { file, output, output_dir, auto_download } => {
            sync_extensions(file, output, output_dir, *auto_download).await?
        },
    }

    Ok(())
}

async fn sync_extensions(file_path: &Path, output_path: &Path, output_dir: &Path, auto_download: bool) -> Result<()> {
    println!("{}", "확장 프로그램 목록을 확인하는 중...".blue());
    
    // 결과 파일 초기화
    if output_path.exists() {
        println!("{}", "기존 결과 파일을 초기화합니다...".yellow());
        fs::remove_file(output_path)
            .with_context(|| format!("Failed to remove existing results file: {}", output_path.display()))?;
    }
    
    // 다운로드 디렉토리 초기화
    if output_dir.exists() {
        println!("{}", "기존 다운로드 디렉토리를 초기화합니다...".yellow());
        fs::remove_dir_all(output_dir)
            .with_context(|| format!("Failed to remove existing download directory: {}", output_dir.display()))?;
    }
    
    // 다운로드 디렉토리 생성
    create_dir_all(output_dir)
        .with_context(|| format!("Failed to create download directory: {}", output_dir.display()))?;
    
    // YAML 파일 읽기
    let yaml_content = fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read file: {}", file_path.display()))?;
    
    let extensions: Extensions = serde_yaml::from_str(&yaml_content)
        .with_context(|| "Failed to parse YAML file")?;
    
    let enabled_extensions = extensions.enabled.unwrap_or_default();
    
    println!("{} {}", "총".blue(), format!("{} 개의 확장 프로그램을 확인합니다...", enabled_extensions.len()).blue());
    
    let mut results = Results {
        available: Vec::new(),
        unavailable: Vec::new(),
    };
    
    let client = Client::new();
    
    for extension in enabled_extensions {
        if extension.id.is_empty() {
            continue;
        }
        
        // Open VSX에서 확장 프로그램 확인
        let url = format!("{}/{}", OPEN_VSX_API, extension.id.replace(".", "/"));
        
        match client.get(&url).send().await {
            Ok(response) => {
                if response.status().is_success() {
                    let data: serde_json::Value = response.json().await
                        .with_context(|| format!("Failed to parse response for extension: {}", extension.id))?;
                    
                    // Open VSX API 구조 확인 - files.download 또는 downloads.universal 필드에서 URL 가져오기
                    let download_url = data.get("files")
                        .and_then(|files| files.get("download"))
                        .and_then(|v| v.as_str())
                        .or_else(|| {
                            data.get("downloads")
                                .and_then(|downloads| downloads.get("universal"))
                                .and_then(|v| v.as_str())
                        });
                    
                    if let Some(url) = download_url {
                        // Open VSX에서 사용 가능한 확장 프로그램
                        println!("{} {}: {}", "확인".green(), extension.id, "Open VSX에서 사용 가능".green());
                        results.available.push(AvailableExtension {
                            id: extension.id.clone(),
                            uuid: extension.uuid.clone(),
                            url: url.to_string(),
                        });
                    } else {
                        // Open VSX에 있지만 다운로드 URL이 없는 경우 - VSCode Marketplace에서 다운로드 필요
                        println!("{} {}: {}", "확인".yellow(), extension.id, "VSCode Marketplace에서 다운로드 필요".yellow());
                        results.unavailable.push(UnavailableExtension {
                            id: extension.id.clone(),
                            uuid: extension.uuid.clone(),
                        });
                    }
                } else {
                    // Open VSX에 없는 확장 프로그램 - VSCode Marketplace에서 다운로드 필요
                    results.unavailable.push(UnavailableExtension {
                        id: extension.id.clone(),
                        uuid: extension.uuid.clone(),
                    });
                }
            },
            Err(_) => {
                // 요청 오류 - VSCode Marketplace에서 다운로드 시도
                results.unavailable.push(UnavailableExtension {
                    id: extension.id.clone(),
                    uuid: extension.uuid.clone(),
                });
            }
        }
    }
    
    println!(
        "{}", 
        format!("\n확인 완료:\n- Open VSX에서 사용 가능: {}개\n- VSCode Marketplace에서 다운로드 필요: {}개", 
            results.available.len(), 
            results.unavailable.len()
        ).blue()
    );
    
    // 결과를 JSON 파일로 저장
    let json = serde_json::to_string_pretty(&results)
        .with_context(|| "Failed to serialize results to JSON")?;
    
    fs::write(output_path, json)
        .with_context(|| format!("Failed to write results to {}", output_path.display()))?;
    
    println!("{} {}", "결과가".green(), format!("{} 파일에 저장되었습니다.", output_path.display()).green());
    
    // 다운로드 필요한 확장 프로그램이 있는 경우
    if !results.unavailable.is_empty() {
        let download_count = results.unavailable.len();
        
        // 자동 다운로드 옵션이 있는 경우 바로 다운로드 시작
        if auto_download {
            println!("{}", format!("VSCode Marketplace에서 {} 개의 확장 프로그램을 다운로드합니다...", download_count).yellow());
            download_marketplace_extensions(&results.unavailable, output_dir).await?
        } else {
            // 사용자에게 다운로드 여부 묻기
            println!(
                "{}\n{}", 
                format!("VSCode Marketplace에서 {} 개의 확장 프로그램을 다운로드하시겠습니까? (y/n)", download_count).yellow(),
                "다운로드할 확장 프로그램: ".yellow()
            );
            
            // 확장 프로그램 ID 출력
            for (i, extension) in results.unavailable.iter().enumerate() {
                if i > 0 && i % 5 == 0 {
                    println!();
                }
                print!("{}{}", extension.id.yellow(), if i < results.unavailable.len() - 1 { ", " } else { "" });
            }
            println!();
            
            // 사용자 입력 받기
            let mut input = String::new();
            std::io::stdin().read_line(&mut input)?;
            
            if input.trim().to_lowercase() == "y" {
                println!("{}", format!("VSCode Marketplace에서 {} 개의 확장 프로그램을 다운로드합니다...", download_count).green());
                download_marketplace_extensions(&results.unavailable, output_dir).await?
            } else {
                println!("{}", "다운로드를 취소했습니다.".red());
            }
        }
    } else {
        println!("{}", "VSCode Marketplace에서 다운로드할 확장 프로그램이 없습니다.".green());
    }
    
    Ok(())
}

async fn download_marketplace_extensions(extensions: &[UnavailableExtension], output_dir: &Path) -> Result<()> {
    println!("{}", "VSCode Marketplace에서 확장 프로그램 다운로드 중...".blue());
    
    // 다운로드 디렉토리 생성
    create_dir_all(output_dir)
        .with_context(|| format!("Failed to create directory: {}", output_dir.display()))?;
    
    let mut success_count = 0;
    let mut failure_count = 0;
    
    for extension in extensions {
        println!("{} {}", extension.id.yellow(), "다운로드 중...".blue());
        
        // 파일 이름 생성 - ID를 우선적으로 사용
        let file_name = format!("{}.vsix", extension.id.replace(".", "-"));
        
        // 다운로드 정보 생성
        match create_download_info(&extension.id, None, Some(&file_name), output_dir).await {
            Ok(download_info) => {
                println!("{} {}", "다운로드 정보가 생성되었습니다:".green(), download_info.direct_download_url);
                
                // 실제 파일 다운로드 시도
                match download_file(&download_info.direct_download_url, &download_info.download_path).await {
                    Ok(_) => {
                        println!("{} {}", "다운로드 성공:".green(), download_info.file_name);
                        update_download_status(&download_info.id, true)?;
                        success_count += 1;
                    },
                    Err(e) => {
                        println!("{} {}: {}", "다운로드 실패".red(), download_info.file_name, e);
                        update_download_status(&download_info.id, false)?;
                        failure_count += 1;
                    }
                }
            },
            Err(err) => {
                println!("{} {}: {}", extension.id.red(), "다운로드 정보 생성 실패".red(), err);
                failure_count += 1;
            }
        }
    }
    
    println!(
        "{}", 
        format!("모든 확장 프로그램 처리 완료: {}개 성공, {}개 실패", 
            success_count, 
            failure_count
        ).green()
    );
    
    Ok(())
}

async fn create_download_info(
    extension_id: &str, 
    version: Option<&str>, 
    custom_file_name: Option<&str>,
    output_dir: &Path
) -> Result<DownloadInfo> {
    println!("{} {}", "VSCode Marketplace에서".blue(), format!("{} 확장 프로그램 다운로드 정보 생성 중...", extension_id).blue());
    
    // 확장 프로그램 ID를 게시자와 이름으로 분리
    let parts: Vec<&str> = extension_id.split('.').collect();
    
    if parts.len() != 2 {
        return Err(anyhow!("유효하지 않은 확장 프로그램 ID 형식: {}", extension_id));
    }
    
    let (publisher, name) = (parts[0], parts[1]);
    
    // 파일 이름 생성
    let file_name = match custom_file_name {
        Some(name) => name.to_string(),
        None => format!("{}.vsix", extension_id.replace(".", "-")),
    };
    
    // 마켓플레이스 URL 생성
    let marketplace_url = format!("{}/{}.{}", VSCODE_MARKETPLACE_URL, publisher, name);
    
    // 직접 다운로드 URL 생성
    let version_str = version.unwrap_or("latest");
    let direct_download_url = format!(
        "https://{}.gallery.vsassets.io/_apis/public/gallery/publisher/{}/extension/{}/{}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage",
        publisher, publisher, name, version_str
    );
    
    // 출력 경로 생성
    let output_path = output_dir.join(&file_name);
    
    // 다운로드 정보 생성
    let download_info = DownloadInfo {
        id: extension_id.to_string(),
        marketplace_url,
        direct_download_url,
        download_path: output_path.to_string_lossy().to_string(),
        file_name,
        version: version.map(|v| v.to_string()),
        timestamp: Utc::now().to_rfc3339(),
        success: false,
    };
    
    // 다운로드 정보를 JSON 파일에 저장
    let downloads_json = PathBuf::from("downloads.json");
    let mut downloads = Vec::new();
    
    if downloads_json.exists() {
        let content = fs::read_to_string(&downloads_json)
            .with_context(|| format!("Failed to read {}", downloads_json.display()))?;
        
        downloads = serde_json::from_str(&content)
            .unwrap_or_else(|_| Vec::new());
    }
    
    // 중복 항목 제거
    downloads.retain(|d: &DownloadInfo| d.id != extension_id);
    downloads.push(download_info.clone());
    
    let json = serde_json::to_string_pretty(&downloads)
        .with_context(|| "Failed to serialize downloads to JSON")?;
    
    fs::write(&downloads_json, json)
        .with_context(|| format!("Failed to write downloads to {}", downloads_json.display()))?;
    
    println!("{}", "다운로드 정보가 downloads.json 파일에 저장되었습니다.".green());
    
    Ok(download_info)
}

async fn download_file(url: &str, output_path: &str) -> Result<()> {
    let client = Client::new();
    
    // 진행률 표시를 위한 설정
    let progress_style = ProgressStyle::default_bar()
        .template("[{elapsed_precise}] {bar:40.cyan/blue} {pos:>7}/{len:7} {msg}")
        .unwrap()
        .progress_chars("##-");
    
    println!("{} {}", "다운로드 시작:".blue(), url);
    
    // 요청 보내기
    let res = client.get(url)
        .send()
        .await
        .with_context(|| format!("Failed to send request to {}", url))?;
    
    // 응답 상태 확인
    if !res.status().is_success() {
        return Err(anyhow!("서버 오류: {}", res.status()));
    }
    
    // 전체 파일 크기 가져오기
    let total_size = res.content_length().unwrap_or(0);
    
    // 진행률 표시바 생성
    let pb = ProgressBar::new(total_size);
    pb.set_style(progress_style);
    pb.set_message(format!("Downloading {}", output_path));
    
    // 스트림으로 다운로드
    let mut stream = res.bytes_stream();
    let output_path = Path::new(output_path);
    
    // 출력 파일 생성
    let mut file = File::create(output_path)
        .with_context(|| format!("Failed to create file: {}", output_path.display()))?;
    
    // 스트림에서 데이터 처리
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| "Failed to download chunk")?;
        file.write_all(&chunk)
            .with_context(|| "Failed to write chunk to file")?;
        pb.inc(chunk.len() as u64);
    }
    
    pb.finish_with_message(format!("다운로드 완료: {}", output_path.display()));
    
    Ok(())
}

fn update_download_status(extension_id: &str, success: bool) -> Result<()> {
    let downloads_json = PathBuf::from("downloads.json");
    
    if downloads_json.exists() {
        let content = fs::read_to_string(&downloads_json)
            .with_context(|| format!("Failed to read {}", downloads_json.display()))?;
        
        let mut downloads: Vec<DownloadInfo> = serde_json::from_str(&content)
            .with_context(|| "Failed to parse downloads.json")?;
        
        // 해당 ID의 확장 프로그램 찾기
        if let Some(download) = downloads.iter_mut().find(|d| d.id == extension_id) {
            // 성공 상태 업데이트
            download.success = success;
            download.timestamp = Utc::now().to_rfc3339();
            
            let json = serde_json::to_string_pretty(&downloads)
                .with_context(|| "Failed to serialize downloads to JSON")?;
            
            fs::write(&downloads_json, json)
                .with_context(|| format!("Failed to write downloads to {}", downloads_json.display()))?;
            
            println!("{}", "다운로드 상태가 업데이트되었습니다.".green());
        }
    }
    
    Ok(())
}

// 불필요한 함수 제거
