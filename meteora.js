import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as readline from 'readline';
import bs58 from 'bs58';

class MeteoraSniper {
    constructor() {
        this.connection = new Connection(
            'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        this.wallet = null;
        this.tokenAddress = null;
        this.swapAmount = {
            SOL: 0,
            USDC: 0
        };
        this.retryCount = 0;
        this.slippage = 30;
        this.checkInterval = 500;
        this.meteoraProgramId = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
        this.usdcAddress = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    }

    getKeypairFromPrivateKey(privateKey) {
        const decodedKey = bs58.decode(privateKey);
        return Keypair.fromSecretKey(decodedKey);
    }

    async findMeteoraPools(tokenAddress) {
        try {
            console.log('Meteora 풀 주소를 검색중입니다...');
            const signatures = await this.connection.getSignaturesForAddress(
                this.meteoraProgramId,
                { limit: 100 }
            );

            for (const sig of signatures) {
                const tx = await this.connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0
                });
                
                if (!tx) continue;

                for (const accountKey of tx.transaction.message.accountKeys) {
                    const accountInfo = await this.connection.getAccountInfo(accountKey);
                    if (!accountInfo) continue;

                    try {
                        const poolData = this.parsePoolData(accountInfo.data);
                        if (poolData && poolData.isActive) {
                            // 풀 타입 확인 (SOL 또는 USDC)
                            const isUsdcPool = tx.transaction.message.accountKeys.some(
                                key => key.equals(this.usdcAddress)
                            );
                            
                            this.poolType = isUsdcPool ? 'USDC' : 'SOL';
                            console.log(`활성화된 ${this.poolType} 풀 발견: ${accountKey.toString()}`);
                            
                            return {
                                poolAddress: accountKey,
                                poolData: poolData
                            };
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
            throw new Error('활성화된 Meteora 풀을 찾을 수 없습니다.');
        } catch (error) {
            console.error('풀 검색 중 오류:', error);
            throw error;
        }
    }

    async getUserInput() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            const privateKey = await new Promise(resolve => {
                rl.question('개인키를 입력하세요: ', resolve);
            });
            this.wallet = this.getKeypairFromPrivateKey(privateKey);
            console.log('지갑 주소:', this.wallet.publicKey.toString());

            // SOL 스왑 금액 입력
            const solAmountStr = await new Promise(resolve => {
                rl.question('SOL로 스왑할 경우의 금액을 입력하세요(최소 0.1sol): ', resolve);
            });
            this.swapAmount.SOL = parseFloat(solAmountStr);
            
            // USDC 스왑 금액 입력
            const usdcAmountStr = await new Promise(resolve => {
                rl.question('USDC로 스왑할 경우의 금액을 입력하세요: ', resolve);
            });
            this.swapAmount.USDC = parseFloat(usdcAmountStr);
            
            if (isNaN(this.swapAmount.SOL) || isNaN(this.swapAmount.USDC) || 
                this.swapAmount.SOL <= 0 || this.swapAmount.USDC <= 0) {
                throw new Error('유효하지 않은 스왑 금액입니다.');
            }

            const tokenAddress = await new Promise(resolve => {
                rl.question('구매할 토큰 컨트랙트 주소를 입력하세요: ', resolve);
            });
            this.tokenAddress = new PublicKey(tokenAddress);

            const confirm = await new Promise(resolve => {
                rl.question(`
⚠️ 주의사항:
1. 입력하신 토큰의 Meteora 풀이 생성되면 자동으로 스왑을 시도합니다.
2. SOL 풀일 경우 ${this.swapAmount.SOL} SOL로, USDC 풀일 경우 ${this.swapAmount.USDC} USDC로 스왑합니다.
3. 잔액이 부족할 때까지 계속 시도합니다.
4. 슬리피지는 ${this.slippage}%로 설정되어 있습니다.
5. 거래가 실패해도 가스비는 차감됩니다.

계속하시겠습니까? (y/n): `, resolve);
            });

            if (confirm.toLowerCase() !== 'y') {
                console.log('프로그램을 종료합니다.');
                process.exit(0);
            }

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
            
            await this.getUserInput();
            
            if (!this.wallet || !this.tokenAddress) {
                throw new Error('필수 정보가 모두 입력되지 않았습니다.');
            }
            
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
        console.log('Meteora 프로그램 모니터링 시작...');
        console.log(`대상 토큰: ${this.tokenAddress.toString()}`);
        console.log('새로운 풀 생성을 감시합니다...');

        // 실시간 트랜잭션 모니터링
        this.connection.onLogs(
            this.meteoraProgramId,
            async (logs) => {
                try {
                    if (logs.err) return;

                    // 트랜잭션의 로그를 분석하여 풀 생성 감지
                    const tx = await this.connection.getTransaction(logs.signature, {
                        maxSupportedTransactionVersion: 0
                    });

                    if (!tx) return;

                    // 트랜잭션에서 새로 생성된 풀 찾기
                    for (const accountKey of tx.transaction.message.accountKeys) {
                        const accountInfo = await this.connection.getAccountInfo(accountKey);
                        if (!accountInfo) continue;

                        try {
                            const poolData = this.parsePoolData(accountInfo.data);
                            if (!poolData || !poolData.isActive) continue;

                            // 풀에 목표 토큰이 포함되어 있는지 확인
                            if (tx.transaction.message.accountKeys.some(key => key.equals(this.tokenAddress))) {
                                const isUsdcPool = tx.transaction.message.accountKeys.some(
                                    key => key.equals(this.usdcAddress)
                                );
                                
                                const poolType = isUsdcPool ? 'USDC' : 'SOL';
                                console.log(`새로운 ${poolType} 풀 발견!`);
                                console.log(`풀 주소: ${accountKey.toString()}`);
                                console.log(`스왑 금액: ${this.swapAmount[poolType]} ${poolType}`);

                                // 즉시 스왑 실행
                                await this.executeBuy(accountKey, poolType);
                                return;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                } catch (error) {
                    console.error('트랜잭션 처리 중 오류:', error);
                }
            },
            'confirmed'
        );
    }

    async executeBuy(poolAddress, poolType) {
        console.log(`스왑 실행 중... (${++this.retryCount}번째 시도)`);
        // 스왑 로직 실행
        // ... 스왑 실행 코드 ...
    }

    async createSwapInstruction(programId, poolAddress, userAddress, tokenAddress, amount) {
        const data = Buffer.alloc(9);
        data.writeUInt8(0, 0);
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
            if (!accountInfo) {
                console.log('풀 데이터를 찾을 수 없습니다. 주소를 다시 확인해주세요.');
                process.exit(1);
            }
            
            await this.handlePoolUpdate(accountInfo);
        } catch (error) {
            console.error('풀 확인 중 오류:', error);
            setTimeout(() => this.checkPoolLiquidity(), this.checkInterval);
        }
    }

    parsePoolData(data) {
        try {
            return {
                version: data.readUInt8(0),
                poolType: data.readUInt8(1),
                tokenAReserve: data.readBigUInt64LE(8),
                tokenBReserve: data.readBigUInt64LE(16),
                feeRate: data.readUInt16LE(24),
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

        const minLiquidity = 0.1 * LAMPORTS_PER_SOL;
        if (poolData.tokenAReserve < minLiquidity) {
            return false;
        }

        return true;
    }
}

console.log('Meteora 스나이핑 봇을 시작합니다...');
const bot = new MeteoraSniper();
bot.initialize().catch(console.error); 
