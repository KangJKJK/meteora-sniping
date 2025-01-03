import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
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
                { limit: 1000 }
            );

            for (const sig of signatures) {
                const tx = await this.connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0
                });
                
                if (!tx) continue;

                if (!tx.transaction.message.accountKeys.some(key => key.toString() === tokenAddress.toString())) {
                    continue;
                }

                for (const accountKey of tx.transaction.message.accountKeys) {
                    const accountInfo = await this.connection.getAccountInfo(accountKey);
                    if (!accountInfo) continue;

                    try {
                        const poolData = this.parsePoolData(accountInfo.data);
                        if (poolData && poolData.isActive) {
                            const isUsdcPool = tx.transaction.message.accountKeys.some(
                                key => key.equals(this.usdcAddress)
                            );
                            
                            this.poolType = isUsdcPool ? 'USDC' : 'SOL';
                            
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
            
            console.log('설정이 완료되었습니다.');
            
            while (true) {  // 무한 반복
                try {
                    // 1. 기존 풀 검색
                    const pool = await this.findMeteoraPools(this.tokenAddress);
                    if (pool) {
                        console.log(`기존 ${this.poolType} 풀 발견!`);
                        console.log(`풀 주소: ${pool.poolAddress.toString()}`);
                        console.log(`스왑 금액: ${this.swapAmount[this.poolType]} ${this.poolType}`);
                        await this.executeBuy(pool.poolAddress, this.poolType);
                        continue;  // 스왑 후 다시 처음부터 시작
                    }
                } catch (error) {
                    // 2. 기존 풀 없으면 새로운 풀 감시
                    console.log('기존 풀이 없습니다. 새로운 풀 생성을 감시합니다...');
                    await this.startMonitoring();
                }
            }

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

        return new Promise((resolve) => {
            this.connection.onLogs(
                this.meteoraProgramId,
                async (logs) => {
                    try {
                        if (logs.err) return;

                        const tx = await this.connection.getTransaction(logs.signature, {
                            maxSupportedTransactionVersion: 0
                        });

                        if (!tx) return;

                        for (const accountKey of tx.transaction.message.accountKeys) {
                            const accountInfo = await this.connection.getAccountInfo(accountKey);
                            if (!accountInfo) continue;

                            try {
                                const poolData = this.parsePoolData(accountInfo.data);
                                if (!poolData || !poolData.isActive) continue;

                                if (tx.transaction.message.accountKeys.some(key => key.equals(this.tokenAddress))) {
                                    const isUsdcPool = tx.transaction.message.accountKeys.some(
                                        key => key.equals(this.usdcAddress)
                                    );
                                    
                                    const poolType = isUsdcPool ? 'USDC' : 'SOL';
                                    console.log(`새로운 ${poolType} 풀 발견!`);
                                    console.log(`풀 주소: ${accountKey.toString()}`);
                                    console.log(`스왑 금액: ${this.swapAmount[poolType]} ${poolType}`);

                                    await this.executeBuy(accountKey, poolType);
                                    resolve();  // 풀을 찾으면 모니터링 종료
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
        });
    }

    async executeBuy(poolAddress, poolType) {
        try {
            // 잔액 확인
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            if (balance < 0.1 * LAMPORTS_PER_SOL) {
                console.log('잔액이 부족합니다. 프로그램을 종료합니다.');
                process.exit(0);
            }

            console.log(`스왑 실행 중... (${++this.retryCount}번째 시도)`);

            // 스왑 금액 설정
            const amount = poolType === 'SOL' ? 
                this.swapAmount.SOL * LAMPORTS_PER_SOL : 
                this.swapAmount.USDC * (10 ** 6);

            // 트랜잭션 생성
            const transaction = new Transaction();
            
            // 스왑 인스트럭션 추가
            const swapIx = await this.createSwapInstruction(
                this.meteoraProgramId,
                poolAddress,
                this.wallet.publicKey,
                this.tokenAddress,
                amount
            );
            
            transaction.add(swapIx);

            // 트랜잭션 옵션 설정
            const latestBlockhash = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.feePayer = this.wallet.publicKey;

            // 트랜잭션 서명
            const signedTx = await this.wallet.signTransaction(transaction);

            // 트랜잭션 전송
            const txId = await this.connection.sendRawTransaction(signedTx.serialize());
            console.log(`트랜잭션 전송됨: https://solscan.io/tx/${txId}`);

            // 트랜잭션 확인
            const confirmation = await this.connection.confirmTransaction({
                signature: txId,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            });

            if (confirmation.value.err) {
                throw new Error('트랜잭션 실패');
            }

            console.log('스왑 성공!');
            
            // 성공 여부와 관계없이 0.2초 후 다음 스왑 시도
            setTimeout(() => {
                this.executeBuy(poolAddress, poolType);
            }, 200); // 200ms = 0.2초

        } catch (error) {
            console.error('스왑 실행 중 오류:', error);
            // 오류 발생시에도 0.2초 후 다시 시도
            setTimeout(() => {
                this.executeBuy(poolAddress, poolType);
            }, 200);
        }
    }

    async createSwapInstruction(programId, poolAddress, userAddress, tokenAddress, amount) {
        // Meteora 스왑 인스트럭션 데이터 생성
        const data = Buffer.alloc(9);
        data.writeUInt8(0, 0); // 스왑 명령어 인덱스
        data.writeBigUInt64LE(BigInt(amount), 1);

        // 필요한 계정들 설정
        const keys = [
            { pubkey: poolAddress, isSigner: false, isWritable: true },
            { pubkey: userAddress, isSigner: true, isWritable: true },
            { pubkey: tokenAddress, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            // 필요한 경우 추가 계정들...
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
