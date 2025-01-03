#!/bin/bash

echo "Meteora 스나이핑 봇 설치 스크립트를 시작합니다..."

# 필수 패키지 설치
echo "시스템 패키지를 업데이트하고 필수 도구를 설치합니다..."
sudo apt-get update
sudo apt-get install -y curl
sudo apt-get install -y git
sudo apt-get install -y build-essential

# Node.js 설치 (최신 LTS 버전)
echo "Node.js를 설치합니다..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# npm 버전 확인
echo "Node.js와 npm 버전을 확인합니다..."
node --version
npm --version

# 프로젝트 디렉토리 생성 및 이동
echo "프로젝트 디렉토리를 생성합니다..."
mkdir -p meteora-bot
cd meteora-bot

# package.json 생성
echo "package.json을 생성합니다..."
npm init -y

# 필요한 npm 패키지 설치
echo "필요한 npm 패키지를 설치합니다..."
npm install @solana/web3.js
npm install typescript
npm install ts-node
npm install bs58
npm install @types/node

# TypeScript 설정 파일 생성
echo "TypeScript 설정 파일을 생성합니다..."
cat > tsconfig.json << EOL
{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
EOL

# meteora.js 파일을 meteora.ts로 복사 (TypeScript 파일로 변환)
echo "meteora.ts 파일을 생성합니다..."
cp ../meteora.js ./meteora.ts

# 실행 권한 부여
chmod +x meteora.ts

echo "설치가 완료되었습니다. 봇을 실행합니다..."
npx ts-node meteora.ts 