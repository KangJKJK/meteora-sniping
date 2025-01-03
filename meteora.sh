#!/bin/bash

echo "Meteora 스나이핑 봇 설치 스크립트를 시작합니다..."

# 필수 패키지 설치
echo "시스템 패키지를 업데이트하고 필수 도구를 설치합니다..."
sudo apt-get update
sudo apt-get install -y curl
sudo apt-get install -y git
sudo apt-get install -y build-essential

# 기존 Node.js 제거
echo "기존 Node.js를 제거합니다..."
sudo apt-get remove nodejs npm -y
sudo apt-get autoremove -y

# Node.js 최신 LTS 버전 설치
echo "Node.js 최신 버전을 설치합니다..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs

# Node.js 버전 확인
echo "설치된 Node.js 버전:"
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
npm install bs58

# meteora.js 파일 다운로드
echo "meteora.js 파일을 다운로드합니다..."
curl -o meteora.js https://raw.githubusercontent.com/KangJKJK/meteora-sniping/main/meteora.js

# 실행 권한 부여
chmod +x meteora.js

echo "설치가 완료되었습니다. 봇을 실행합니다..."
node meteora.js 
