import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as readline from 'readline';
import bs58 from 'bs58';

class MeteoraSniper {
    private connection: Connection;
    private wallet: Keypair | null = null;
    private tokenAddress: PublicKey | null = null;
    private poolAddress: PublicKey | null = null;
    private swapAmount: number = 0;
    private slippage: number = 30;
    private maxRetries: number = 1000; // 최대 시도 횟수
    private retryCount: number = 0;

    constructor() {
        this.connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    }

    private getKeypairFromPrivateKey(privateKey: string): Keypair {
        try {
            const decoded = bs58.decode(privateKey);
            return Keypair.fromSecretKey(decoded);
        } catch (error) {
            throw new Error('잘못된 개인키 형식입니다.');
        }
    }

    private async getUserInput(): Promise<void> {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            // 개인키 입력 받기
            const privateKey = await new Promise<string>((resolve) => {
                rl.question('개인키를 입력하세요: ', resolve);
            });
            this.wallet = this.getKeypairFromPrivateKey(privateKey);
            console.log('지갑 주소:', this.wallet.publicKey.toString());

            // 스왑 금액 입력 받기
            const swapAmountStr = await new Promise<string>((resolve) => {
                rl.question('스왑할 SOL 금액을 입력하세요(최소 0.1sol): ', resolve);
            });
            this.swapAmount = parseFloat(swapAmountStr);
            
            if (isNaN(this.swapAmount) || this.swapAmount <= 0) {
                throw new Error('유효하지 않은 스왑 금액입니다.');
            }

            // 경고 메시지 표시 및 확인
            const confirm = await new Promise<string>((resolve) => {
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
            const tokenAddress = await new Promise<string>((resolve) => {
                rl.question('토큰 컨트랙트 주소를 입력하세요: ', resolve);
            });
            this.tokenAddress = new PublicKey(tokenAddress);

            // 풀 주소 입력 받기
            const poolAddress = await new Promise<string>((resolve) => {
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

    private async checkWalletBalance() {
        if (!this.wallet) return;
        
        const balance = await this.connection.getBalance(this.wallet.publicKey);
        console.log(`지갑 잔액: ${balance / 10 ** 9} SOL`);
        
        if (balance < 0.1 * 10 ** 9) {
            throw new Error('지갑 잔액이 너무 적습니다. 최소 0.1 SOL이 필요합니다.');
        }
    }

    private async startMonitoring() {
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

    private async executeBuy() {
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
            // 여기에 실제 스왑 로직 구현
            
        } catch (error) {
            console.error('스왑 실행 중 오류:', error);
        }
    }

    private async handlePoolUpdate(accountInfo: any) {
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

    private async checkPoolLiquidity() {
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

    // ... (나머지 코드는 이전과 동일)
}

// 봇 실행
console.log('Meteora 스나이핑 봇을 시작합니다...');
const bot = new MeteoraSniper();
bot.initialize().catch(console.error); 