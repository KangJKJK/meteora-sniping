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
                rl.question('SOL로 스왑할 경우의 금액을 입력하세요(최소 0.1sol): ', resolve);
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
        // 잔액 확인
        const balance = await this.connection.getBalance(this.wallet.publicKey);
        if (balance < 0.1 * LAMPORTS_PER_SOL) {
            console.log('잔액이 부족합니다. 프로그램을 종료합니다.');
            process.exit(0);
        }

        const amount = this.swapAmount.SOL * LAMPORTS_PER_SOL;
        
        // Jupiter API를 통한 스왑 실행
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${this.tokenAddress.toString()}&amount=${amount}&slippageBps=50`
        );
        const quoteData = await quoteResponse.json();

        if (!quoteData.routes || quoteData.routes.length === 0) {
            throw new Error('사용 가능한 스왑 경로가 없습니다.');
        }

        // 트랜잭션 생성
        const transactionResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                route: quoteData.routes[0],
                userPublicKey: this.wallet.publicKey.toString(),
                wrapUnwrapSOL: true
            })
        });

        const transactionData = await transactionResponse.json();
        const transaction = Transaction.from(Buffer.from(transactionData.swapTransaction, 'base64'));

        // 트랜잭션 서명 및 전송
        transaction.feePayer = this.wallet.publicKey;
        const signedTx = await this.wallet.signTransaction(transaction);
        const txid = await this.connection.sendRawTransaction(signedTx.serialize());
        console.log(`트랜잭션 전송됨: https://solscan.io/tx/${txid}`);

        // 트랜잭션 확인
        await this.connection.confirmTransaction(txid);
        console.log('스왑 성공!');
    }
}

console.log('스나이핑 봇을 시작합니다...');
const bot = new MeteoraSniper();
bot.initialize().catch(console.error); 
