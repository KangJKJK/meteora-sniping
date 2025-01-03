import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
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
            const privateKey = await new Promise(resolve => {
                rl.question('개인키를 입력하세요: ', resolve);
            });
            this.wallet = this.getKeypairFromPrivateKey(privateKey);
            console.log('지갑 주소:', this.wallet.publicKey.toString());

            const solAmountStr = await new Promise(resolve => {
                rl.question('스왑을 진행할 sol을 입력하세요(최소 0.1sol,계속반복스왑): ', resolve);
            });
            this.swapAmount.SOL = parseFloat(solAmountStr);
            
            if (isNaN(this.swapAmount.SOL) || this.swapAmount.SOL <= 0) {
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
            
            // Jupiter를 통한 연속 스왑 시도
            while (true) {
                try {
                    await this.executeJupiterSwap();
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    console.log('스왑 실패, 0.2초 후 재시도...');
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

        } catch (error) {
            console.error('초기화 중 오류 발생:', error);
            process.exit(1);
        }
    }

    async executeJupiterSwap() {
        try {
            // 잔액 확인
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            if (balance < 0.1 * LAMPORTS_PER_SOL) {
                console.log('잔액이 부족합니다. 프로그램을 종료합니다.');
                process.exit(0);
            }

            const amount = this.swapAmount.SOL * LAMPORTS_PER_SOL;
            
            // 1. Jupiter API를 통한 스왑 견적 요청 (슬리피지 30%)
            console.log('스왑 견적 요청 중...');
            const quoteResponse = await fetch(
                `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${this.tokenAddress.toString()}&amount=${amount}&slippageBps=3000&onlyDirectRoutes=true`
            );
            const quoteData = await quoteResponse.json();

            if (!quoteData.routes || quoteData.routes.length === 0) {
                throw new Error('사용 가능한 스왑 경로가 없습니다.');
            }

            console.log('스왑 경로 찾음:', quoteData.routes[0]);

            // 2. 트랜잭션 준비
            console.log('트랜잭션 준비 중...');
            const { blockhash } = await this.connection.getLatestBlockhash('finalized');
            
            // 3. 트랜잭션 생성 (높은 우선순위)
            const transactionResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapUnwrapSOL: true,
                    computeUnitPriceMicroLamports: 5000,  // 우선순위 대폭 상승
                    prioritizationFeeLamports: 10000000,  // 0.01 SOL로 증가
                    blockhash: blockhash,
                    useSharedAccounts: true
                })
            });

            if (!transactionResponse.ok) {
                const errorData = await transactionResponse.json();
                throw new Error(`트랜잭션 생성 실패: ${JSON.stringify(errorData)}`);
            }

            const { swapTransaction } = await transactionResponse.json();
            console.log('트랜잭션 데이터 받음');

            // 4. 트랜잭션 서명
            const transaction = Transaction.from(Buffer.from(swapTransaction, 'base64'));
            transaction.feePayer = this.wallet.publicKey;
            
            const signedTx = await this.wallet.signTransaction(transaction);
            console.log('트랜잭션 서명 완료');

            // 5. 트랜잭션 전송
            const txid = await this.connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: true,
                maxRetries: 3
            });
            console.log(`트랜잭션 전송됨: https://solscan.io/tx/${txid}`);

            // 6. 트랜잭션 확인
            await this.connection.confirmTransaction({
                signature: txid,
                blockhash: blockhash,
                lastValidBlockHeight: await this.connection.getBlockHeight()
            });
            console.log('스왑 성공!');

        } catch (error) {
            console.log('스왑 실패 상세:', error.message);
            throw error;
        }
    }
}

console.log('스나이핑 봇을 시작합니다...');
const bot = new MeteoraSniper();
bot.initialize().catch(console.error); 
