const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const readline = require('readline');
const bs58 = require('bs58');

class MeteoraSniper {
    constructor() {
        this.connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
        this.wallet = null;
        this.tokenAddress = null;
        this.poolAddress = null;
        this.swapAmount = 0;
        this.slippage = 30;
        this.maxRetries = 1000;
        this.retryCount = 0;
    }

    getKeypairFromPrivateKey(privateKey) {
        const decodedKey = bs58.decode(privateKey);
        return Keypair.fromSecretKey(decodedKey);
    }

    async getUserInput() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            // 개인키 입력 받기
            const privateKey = await new Promise((resolve) => {
                rl.question('개인키를 입력하세요: ', resolve);
            });
            this.wallet = this.getKeypairFromPrivateKey(privateKey);
            console.log('지갑 주소:', this.wallet.publicKey.toString());

            // 스왑 금액 입력 받기
            const swapAmountStr = await new Promise((resolve) => {
                rl.question('스왑할 SOL 금액을 입력하세요(최소 0.1sol): ', resolve);
            });
            this.swapAmount = parseFloat(swapAmountStr);
            
            if (isNaN(this.swapAmount) || this.swapAmount <= 0) {
                throw new Error('유효하지 않은 스왑 금액입니다.');
            }

            // 경고 메시지 표시 및 확인
            const confirm = await new Promise((resolve) => {
                rl.question(`
⚠️ 주의사항:
1. 입력하신 ${this.swapAmount} SOL로 스왑을 시도합니다.
2. 잔액이 부족할 때까지 최대 ${this.maxRetries}번 시도합니다.
3. 슬리피지는 ${this.slippage}%로 설정되어 있습니다.
4. 거래가 실패해도 가스비는 차감됩니다.

계속하시겠습니까? (y/n): `, resolve);
            });

            if (confirm.toLowerCase() !== 'y') {
                console.log('프로그램을 종료합니다.');
                process.exit(0);
            }

            // 토큰 주소 입력 받기
            const tokenAddress = await new Promise((resolve) => {
                rl.question('토큰 컨트랙트 주소를 입력하세요: ', resolve);
            });
            this.tokenAddress = new PublicKey(tokenAddress);

            // 풀 주소 입력 받기
            const poolAddress = await new Promise((resolve) => {
                rl.question('풀 주소를 입력하세요: ', resolve);
            });
            this.poolAddress = new PublicKey(poolAddress);

        } catch (error) {
            console.error('입력 오류:', error);
            process.exit(1);
        } finally {
            rl.close();
        }
    }

    async initialize() {
        try {
            console.log('스나이핑 봇 설정을 시작합니다...');
            
            // 사용자 입력 받기
            await this.getUserInput();
            
            if (!this.wallet || !this.tokenAddress || !this.poolAddress) {
                throw new Error('필수 정보가 모두 입력되지 않았습니다.');
            }

            // 지갑 잔액 확인
            await this.checkWalletBalance();
            
            console.log('설정이 완료되었습니다. 모니터링을 시작합니다...');
            await this.startMonitoring();

        } catch (error) {
            console.error('초기화 중 오류 발생:', error);
            process.exit(1);
        }
    }

    async checkWalletBalance() {
        if (!this.wallet) return;
        
        const balance = await this.connection.getBalance(this.wallet.publicKey);
        console.log(`지갑 잔액: ${balance / 10 ** 9} SOL`);
        
        if (balance < 0.1 * 10 ** 9) {
            throw new Error('지갑 잔액이 너무 적습니다. 최소 0.1 SOL이 필요합니다.');
        }
    }

    async startMonitoring() {
        if (!this.poolAddress) return;

        console.log('풀 모니터링 시작...');
        console.log('유동성이 생성될 때까지 0.1초마다 확인합니다...');
        
        // 초기 풀 확인 시작
        await this.checkPoolLiquidity();

        // 실시간 계정 변경 모니터링
        this.connection.onAccountChange(this.poolAddress, async (accountInfo) => {
            try {
                await this.handlePoolUpdate(accountInfo);
            } catch (error) {
                console.error('풀 업데이트 처리 중 오류:', error);
                setTimeout(() => this.checkPoolLiquidity(), 100);
            }
        });
    }

    async executeBuy() {
        if (!this.wallet || this.retryCount >= this.maxRetries) return;

        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            const requiredAmount = this.swapAmount * LAMPORTS_PER_SOL;

            if (balance < requiredAmount) {
                console.log('잔액 부족. 프로그램을 종료합니다.');
                console.log(`시도 횟수: ${this.retryCount}`);
                process.exit(0);
            }

            console.log(`${++this.retryCount}번째 스왑 시도...`);

            // Meteora 프로그램 ID
            const meteoraProgramId = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');

            // 스왑 instruction 생성
            const swapIx = await this.createSwapInstruction(
                meteoraProgramId,
                this.poolAddress,
                this.wallet.publicKey,
                this.tokenAddress,
                requiredAmount
            );

            // 트랜잭션 생성 및 전송
            const transaction = new Transaction().add(swapIx);
            const {blockhash} = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.wallet.publicKey;

            // 트랜잭션 서명 및 전송
            const signedTx = await this.wallet.signTransaction(transaction);
            const txId = await this.connection.sendRawTransaction(signedTx.serialize());
            
            console.log(`스왑 트랜잭션 전송됨: ${txId}`);
            
            // 트랜잭션 확인
            const confirmation = await this.connection.confirmTransaction(txId);
            if (confirmation.value.err) {
                throw new Error('트랜잭션 실패');
            }
            
            console.log('스왑 성공!');
            process.exit(0);

        } catch (error) {
            console.error('스왑 실행 중 오류:', error);
            setTimeout(() => this.executeBuy(), 100);
        }
    }

    async createSwapInstruction(programId, poolAddress, userAddress, tokenAddress, amount) {
        // Meteora 스왑 instruction 데이터 구조
        const data = Buffer.alloc(9);
        data.writeUInt8(0, 0); // instruction index for swap
        data.writeBigUInt64LE(BigInt(amount), 1);

        const keys = [
            {pubkey: poolAddress, isSigner: false, isWritable: true},
            {pubkey: userAddress, isSigner: true, isWritable: true},
            {pubkey: tokenAddress, isSigner: false, isWritable: true},
            {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
        ];

        return new TransactionInstruction({
            keys,
            programId,
            data
        });
    }

    async handlePoolUpdate(accountInfo) {
        try {
            if (!accountInfo.data) {
                console.log('풀 데이터가 없습니다. 0.1초 후 재시도...');
                setTimeout(() => this.checkPoolLiquidity(), 100);
                return;
            }

            const poolData = this.parsePoolData(accountInfo.data);
            if (!poolData) {
                console.log('풀 데이터 파싱 실패. 0.1초 후 재시도...');
                setTimeout(() => this.checkPoolLiquidity(), 100);
                return;
            }
            
            if (this.shouldBuy(poolData)) {
                await this.executeBuy();
            } else {
                setTimeout(() => this.checkPoolLiquidity(), 100);
            }
        } catch (error) {
            console.error('풀 데이터 처리 중 오류:', error);
            setTimeout(() => this.checkPoolLiquidity(), 100);
        }
    }

    async checkPoolLiquidity() {
        if (!this.poolAddress) return;
        
        try {
            const accountInfo = await this.connection.getAccountInfo(this.poolAddress);
            if (accountInfo) {
                await this.handlePoolUpdate(accountInfo);
            } else {
                console.log('⚠️ 풀이 아직 생성되지 않았습니다. 0.1초 후 재시도...');
                setTimeout(() => this.checkPoolLiquidity(), 100);
            }
        } catch (error) {
            console.error('풀 확인 중 오류:', error);
            setTimeout(() => this.checkPoolLiquidity(), 100);
        }
    }

    parsePoolData(data) {
        try {
            // Meteora 풀 데이터 구조
            return {
                // 버전 및 타입 정보
                version: data.readUInt8(0),
                poolType: data.readUInt8(1),
                // 토큰 A/B 리저브
                tokenAReserve: data.readBigUInt64LE(8),
                tokenBReserve: data.readBigUInt64LE(16),
                // 수수료 관련
                feeRate: data.readUInt16LE(24),
                // 풀 상태
                isActive: Boolean(data.readUInt8(26)),
                lastUpdateTime: data.readBigUInt64LE(27)
            };
        } catch (error) {
            console.error('풀 데이터 파싱 오류:', error);
            return null;
        }
    }

    shouldBuy(poolData) {
        if (!poolData.isActive || !poolData.tokenAReserve || !poolData.tokenBReserve) {
            return false;
        }

        // 최소 유동성 확인 (예: 0.1 SOL)
        const minLiquidity = 0.1 * LAMPORTS_PER_SOL;
        if (poolData.tokenAReserve < minLiquidity) {
            return false;
        }

        return true;
    }
}

// 봇 실행
console.log('Meteora 스나이핑 봇을 시작합니다...');
const bot = new MeteoraSniper();
bot.initialize().catch(console.error); 
