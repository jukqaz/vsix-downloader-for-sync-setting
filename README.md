# VSX 확장 프로그램 찾기

VSCode 확장 프로그램을 Open VSX에서 검색하고 VSIX 파일을 다운로드하는 도구입니다. Open VSX 마켓플레이스에서 제공되지 않는 확장 프로그램을 찾아 다운로드할 수 있습니다.

## 기능

- VSCode extensions.yml 파일에서 확장 프로그램 목록 읽기
- Open VSX에서 확장 프로그램 사용 가능 여부 확인
- 사용할 수 없는 확장 프로그램 목록 생성
- VSIX 파일 다운로드 (가능한 경우)
- 웹 인터페이스를 통한 확장 프로그램 관리

## 설치

```bash
# 저장소 클론
git clone https://github.com/yourusername/vsx-extension-finder.git
cd vsx-extension-finder

# 의존성 설치
npm install

# 또는 yarn 사용
yarn install
```

## 사용 방법

### 확장 프로그램 목록 확인

```bash
node index.js check /path/to/extensions.yml
```

### 특정 확장 프로그램 다운로드

```bash
node index.js download publisher.extension-name
```

### 웹 인터페이스 사용

1. 먼저 확장 프로그램 목록을 확인합니다:
   ```bash
   node index.js check /path/to/extensions.yml
   ```

2. 웹 브라우저에서 http://localhost:3000 으로 접속합니다.

3. 사용할 수 없는 확장 프로그램 목록을 확인하고 필요한 VSIX 파일을 다운로드합니다.

## 주의사항

- VSCode Marketplace에서 직접 다운로드하는 것은 API 제한으로 어려울 수 있습니다. 일부 확장 프로그램은 마켓플레이스 웹사이트에서 수동으로 다운로드해야 할 수 있습니다.
- 다운로드한 VSIX 파일은 `downloads` 디렉토리에 저장됩니다.

## 라이선스

MIT
