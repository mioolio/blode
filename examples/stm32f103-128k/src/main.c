/**
 * @file    main.c
 * @brief   STM32F103 烧录验证固件（Flash test / Blink）
 *
 * 目标芯片 : STM32F103x8 / STM32F103xB（中容量, SW-DP ID 0x410）
 * 开发板   : 常见 "Blue Pill" / 最小系统板（8MHz 晶振）
 *
 * 现象（用于判断“烧录成功且程序跑起来了”）：
 *   1) PC13 上的 LED 慢闪：亮 80ms / 灭 920ms（约 1 秒一次心跳）
 *      如果板子没有 HSE 晶振或晶振不起振，程序会自动退回内部 8MHz，
 *      LED 变成 亮 300ms / 灭 700ms，UART 也会打印 HSI。
 *   2) USART1 (PA9=TX, PA10=RX, 115200 8N1) 每 5 次心跳打印一行 "alive N"。
 *   3) 若程序跑飞进 HardFault，LED 变成 100ms 快速闪烁（表示“烧进去了但代码异常”）。
 *
 * 不依赖 HAL/SPL/CMSIS，只用寄存器。
 */

#include "stm32f103_min.h"

/* 可选：由 src/flash_70k.c 提供的 64KB/128KB 容量自检。
 * 工程里没有编入那个文件时，这个弱符号为 0，调用会被跳过。 */
extern void flash_70k_selftest(void) __attribute__((weak));

/* ---------------- 可按板子修改的宏 ---------------- */
#define LED_GPIO        GPIOC
#define LED_PIN         BIT(13)     /* Blue Pill: PC13, 低电平点亮 */

#define UART_BAUD       115200u

/* Flash 里的固定标记：烧录后可在 0x08000130 处看到这串 ASCII，
 * 用来确认“目标地址/文件确实写进去了”。 */
__attribute__((used, section(".fwtag")))
const char fw_tag[] = "STM32F103-FLASH-OK-v1.0";

uint32_t SystemCoreClock = 8000000u;

/* ---------------- 工具函数 ---------------- */

static void delay_ms(uint32_t ms)
{
    /* 用 SysTick 做 1ms 基准，随 SystemCoreClock 自动适配 */
    uint32_t reload = (SystemCoreClock / 1000u) - 1u;
    if (reload > 0x00FFFFFFu) {
        reload = 0x00FFFFFFu;
    }

    SysTick->LOAD = reload;
    SysTick->VAL  = 0u;
    SysTick->CTRL = SYSTICK_CTRL_CLKSOURCE | SYSTICK_CTRL_ENABLE;

    while (ms--) {
        while ((SysTick->CTRL & SYSTICK_CTRL_COUNTFLAG) == 0u) {
            /* wait one tick */
        }
    }

    SysTick->CTRL = 0u;
}

/* ---------------- 时钟 ---------------- */

/**
 * @brief  HSE 8MHz -> PLL x9 -> 72MHz；失败则保持 HSI 8MHz。
 * @return 1 = 72MHz, 0 = 8MHz fallback
 */
uint32_t clock_init(void)
{
    uint32_t timeout;

    /* 确保 HSI 打开（复位后本来就是开的，这里保险起见） */
    RCC_CR |= RCC_CR_HSION;
    timeout = 0x10000u;
    while (((RCC_CR & RCC_CR_HSIRDY) == 0u) && (--timeout != 0u)) {
    }

    /* 打开 HSE 并等待起振 */
    RCC_CR |= RCC_CR_HSEON;
    timeout = 0x80000u;
    while (((RCC_CR & RCC_CR_HSERDY) == 0u) && (--timeout != 0u)) {
    }

    if ((RCC_CR & RCC_CR_HSERDY) == 0u) {
        /* 没有晶振 / 晶振坏：不切 PLL，直接 8MHz 跑，LED 会有明显不同节奏 */
        SystemCoreClock = 8000000u;
        return 0u;
    }

    /* 72MHz 需要 2 个等待周期，并打开预取 */
    FLASH_ACR = FLASH_ACR_PRFTBE | FLASH_ACR_LATENCY_2;

    /* PLL 输入 = HSE，倍频 x9；APB1 = 36MHz，APB2 = 72MHz，ADC = 12MHz */
    RCC_CFGR = (2u << 14)   /* ADCPRE = /6  -> 12MHz        */
             | (4u << 8)    /* PPRE1  = /2  -> 36MHz        */
             | (7u << 18)   /* PLLMUL = x9                  */
             | (1u << 16);  /* PLLSRC = HSE                 */

    RCC_CR |= RCC_CR_PLLON;
    timeout = 0x80000u;
    while (((RCC_CR & RCC_CR_PLLRDY) == 0u) && (--timeout != 0u)) {
    }

    if ((RCC_CR & RCC_CR_PLLRDY) == 0u) {
        SystemCoreClock = 8000000u;
        return 0u;
    }

    /* 切换系统时钟到 PLL */
    RCC_CFGR = (RCC_CFGR & ~0x3u) | 0x2u;
    timeout = 0x80000u;
    while ((((RCC_CFGR >> 2) & 0x3u) != 0x2u) && (--timeout != 0u)) {
    }

    if (((RCC_CFGR >> 2) & 0x3u) != 0x2u) {
        /* 切不过去就退回 HSI */
        RCC_CFGR &= ~0x3u;
        SystemCoreClock = 8000000u;
        return 0u;
    }

    SystemCoreClock = 72000000u;
    return 1u;
}

void SystemCoreClockUpdate(void)
{
    /* 本测试工程用不到，保留空的 CMSIS 兼容接口 */
}

void SystemInit(void)
{
    /* 复位后向量表本来就在 0x08000000，无需重定位。
     * 时钟在 main() 里初始化，方便把结果打印到串口。 */
    SysTick->CTRL = 0u;
    SysTick->VAL  = 0u;
}

/* ---------------- GPIO / LED ---------------- */

static void led_init(void)
{
    RCC_APB2ENR |= RCC_APB2ENR_IOPCEN;

    /* PC13: 输出推挽, 2MHz（CRH 的 bit20..23 = 0b0010） */
    LED_GPIO->CRH = (LED_GPIO->CRH & ~(0xFu << 20)) | (0x2u << 20);
    LED_GPIO->BSRR = LED_PIN;   /* 先熄灭（高电平） */
}

static void led_on(void)
{
    LED_GPIO->BRR = LED_PIN;    /* PC13 拉低 = 点亮 */
}

static void led_off(void)
{
    LED_GPIO->BSRR = LED_PIN;
}

/* ---------------- 串口 ---------------- */

static uint32_t pclk2_hz(void)
{
    /* APB2 分频：PPRE2 = 0b0xx 表示不分频 */
    uint32_t ppre2 = (RCC_CFGR >> 11) & 0x7u;
    if (ppre2 < 4u) {
        return SystemCoreClock;
    }
    return SystemCoreClock >> (ppre2 - 3u);
}

static void uart_init(void)
{
    uint32_t pclk2 = pclk2_hz();

    RCC_APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;

    /* PA9 = AF 推挽 50MHz (0xB), PA10 = 浮空输入 (0x4) */
    GPIOA->CRH = (GPIOA->CRH & ~(0xFFu << 4)) | (0xB4u << 4);

    USART1->BRR = (pclk2 + (UART_BAUD / 2u)) / UART_BAUD;
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;
}

static void uart_putc(char c)
{
    while ((USART1->SR & USART_SR_TXE) == 0u) {
    }
    USART1->DR = (uint32_t)(uint8_t)c;
}

static void uart_puts(const char *s)
{
    while (*s != '\0') {
        uart_putc(*s++);
    }
}

static void uart_put_u32(uint32_t v)
{
    char buf[11];
    int i = 0;

    if (v == 0u) {
        uart_putc('0');
        return;
    }

    while (v != 0u) {
        buf[i++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (i-- > 0) {
        uart_putc(buf[i]);
    }
}

static void uart_put_hex32(uint32_t v)
{
    static const char hex[] = "0123456789ABCDEF";
    uart_puts("0x");
    for (int i = 28; i >= 0; i -= 4) {
        uart_putc(hex[(v >> i) & 0xFu]);
    }
}

static void uart_put_dec_pad3(uint32_t v)
{
    if (v < 100u) { uart_putc('0'); }
    if (v < 10u)  { uart_putc('0'); }
    uart_put_u32(v);
}

/* ---------------- 异常处理（可视化） ---------------- */

static void fault_blink(void) __attribute__((noreturn));
static void fault_blink(void)
{
    for (;;) {
        led_on();
        delay_ms(100);
        led_off();
        delay_ms(100);
    }
}

void HardFault_Handler(void)   { fault_blink(); }
void MemManage_Handler(void)   { fault_blink(); }
void BusFault_Handler(void)    { fault_blink(); }
void UsageFault_Handler(void)  { fault_blink(); }
void NMI_Handler(void)         { fault_blink(); }

/* ---------------- 主程序 ---------------- */

int main(void)
{
    uint32_t pll_ok;
    uint32_t beat = 0u;

    pll_ok = clock_init();

    led_init();
    uart_init();

    uart_puts("\r\n\r\n");
    uart_puts("======================================\r\n");
    uart_puts(" STM32F103 flash test firmware v1.0\r\n");
    uart_puts("======================================\r\n");
    uart_puts("tag      : ");
    uart_puts(fw_tag);
    uart_puts("\r\n");
    uart_puts("tag addr : ");
    uart_put_hex32((uint32_t)(uintptr_t)fw_tag);
    uart_puts("\r\n");
    uart_puts("clock    : ");
    if (pll_ok != 0u) {
        uart_puts("HSE + PLL, 72 MHz\r\n");
    } else {
        uart_puts("HSI fallback, 8 MHz (check 8MHz crystal)\r\n");
    }
    uart_puts("heartbeat: LED on PC13\r\n\r\n");

    /* 编入了 src/flash_70k.c 时，跑一次“64KB 之外能不能用”的自检 */
    if (flash_70k_selftest != 0) {
        flash_70k_selftest();
    }

    for (;;) {
        /* 心跳：短闪一下，方便肉眼判断程序在跑 */
        led_on();
        delay_ms(pll_ok != 0u ? 80u : 300u);
        led_off();
        delay_ms(pll_ok != 0u ? 920u : 700u);

        beat++;

        /* 每秒一次心跳，每 5 次打印一行，避免刷屏 */
        if ((beat % 5u) == 0u) {
            uart_puts("alive ");
            uart_put_dec_pad3(beat / 5u);
            uart_puts("  (");
            uart_put_u32(beat);
            uart_puts(" beats)\r\n");
        }
    }
}
