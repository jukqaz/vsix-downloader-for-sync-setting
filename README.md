# VSIX Downloader

VSCode 확장 프로그램을 Open VSX에서 검색하고 VSCode Marketplace에서 VSIX 파일을 다운로드하는 Rust 명령줄 도구입니다.

## 기능

- YAML 파일에서 확장 프로그램 목록을 확인하고 Open VSX에 없는 확장 프로그램을 VSCode Marketplace에서 다운로드
- 자동 또는 사용자 확인 후 다운로드 진행
- 확장 프로그램 ID 또는 UUID로 필요한 확장 프로그램만 선택적으로 다운로드
- 실행 전 결과 파일과 다운로드 디렉토리 자동 초기화

## 설치

### 소스에서 빌드

```bash
git clone <repository-url>
cargo build --release
```

빌드된 실행 파일은 `target/release/vsix-downloader` 경로에 생성됩니다.

## 사용법

### 확장 프로그램 확인 및 다운로드 (한 번에 처리)

```bash
cargo run -- sync --file extensions.yml -r results.json -o downloads
```

이 명령어는 다음을 수행합니다:
1. 결과 파일과 다운로드 디렉토리 초기화
2. YAML 파일에서 확장 프로그램 목록을 확인
3. Open VSX에 없는 확장 프로그램 목록 표시
4. 사용자에게 다운로드 여부 확인 후 VSCode Marketplace에서 다운로드

자동으로 다운로드하려면 `--auto-download` 옵션을 추가하세요:

```bash
cargo run -- sync --file extensions.yml -r results.json -o downloads --auto-download
```

### 릴리스 버전 사용

릴리스 버전을 빌드한 후 사용하려면:

```bash
./target/release/vsix-downloader sync --file extensions.yml -r results.json -o downloads
```



## YAML 파일 형식

`extensions.yml` 파일은 다음과 같은 형식을 가져야 합니다:

```yaml
enabled:
  - id: ms-python.python
    uuid: 6c2f1801-1e7f-45b2-9b5c-7782f1e076e8
  - id: rust-lang.rust-analyzer
    uuid: 9a21d0ea-ca17-49e3-b7b7-1a0908e9096e
```

## 라이센스

MIT
