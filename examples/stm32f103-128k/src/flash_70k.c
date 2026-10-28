/**
 * @file    flash_70k.c
 * @brief   64KB / 128KB 容量验证用的“大固件”
 *
 * 目的：往 Flash 里塞 72 KB 的已知图案，使最终 .bin 超过 64 KB；
 *       烧进板子后由 main() 通过弱符号调用 flash_70k_selftest()，
 *       把 0x08010000（64KB 边界之后的第一个字）读回来打印：
 *
 *         0xA5A5A5A5 -> 超出 64KB 的部分真的存在（128KB 颗粒）
 *         其它值     -> 超出部分无效/被镜像（实际 64KB）
 *
 * 编译要求：
 *   - GCC 系编译器（用到 GNU 扩展初始化器 [0 ... N-1] = x）
 *   - 链接脚本里 FLASH 长度 >= 128K，否则会报 region overflowed
 *
 * 注意：本文件里的图案数组必须是 const 且被 volatile 方式读取，
 *       否则编译器会把自检比较直接算成常量。
 */

#include "stm32f103_min.h"

#define FLASH_70K_BYTES   (72u * 1024u)   /* 72 KB 图案 */
#define FLASH_70K_FILL    0xA5u
#define FLASH_70K_PROBE   0x08010000u     /* 64KB 边界之后的第一个字 */
#define FLASH_70K_TAIL    4096u           /* 尾部抽检 4KB */

__attribute__((used))
const uint8_t flash_70k_blob[FLASH_70K_BYTES] = {
    [0 ... (FLASH_70K_BYTES - 1u)] = FLASH_70K_FILL
};

/* ---------------- 本地串口输出（USART1 已由 main 初始化） ---------------- */

static void tx(char c)
{
    while ((USART1->SR & USART_SR_TXE) == 0u) {
    }
    USART1->DR = (uint32_t)(uint8_t)c;
}

static void tx_str(const char *s)
{
    while (*s != '\0') {
        tx(*s++);
    }
}

static void tx_u32(uint32_t v)
{
    char buf[11];
    int i = 0;

    if (v == 0u) {
        tx('0');
        return;
    }
    while (v != 0u) {
        buf[i++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (i-- > 0) {
        tx(buf[i]);
    }
}

static void tx_hex(uint32_t v)
{
    static const char hex[] = "0123456789ABCDEF";
    tx_str("0x");
    for (int i = 28; i >= 0; i -= 4) {
        tx(hex[(v >> i) & 0xFu]);
    }
}

/* ---------------- 只读访问（volatile，防止编译器常量折叠） ---------------- */

static uint8_t rd8(const uint8_t *p)
{
    return *(const volatile uint8_t *)p;
}

static uint32_t rd32(uint32_t addr)
{
    return *(const volatile uint32_t *)addr;
}

/* ---------------- 自检 ---------------- */

void flash_70k_selftest(void)
{
    const uint32_t base   = (uint32_t)(uintptr_t)flash_70k_blob;
    const uint32_t end    = base + FLASH_70K_BYTES - 1u;
    const uint32_t reg    = (uint32_t)*(const volatile uint16_t *)0x1FFFF7E0u;
    uint32_t probe;
    uint32_t tail_ok = 0u;

    for (uint32_t i = FLASH_70K_BYTES - FLASH_70K_TAIL; i < FLASH_70K_BYTES; i++) {
        if (rd8(&flash_70k_blob[i]) == FLASH_70K_FILL) {
            tail_ok++;
        }
    }

    probe = rd32(FLASH_70K_PROBE);

    tx_str("\r\n---- 64KB / 128KB flash capacity test ----\r\n");
    tx_str("flash size reg : ");
    tx_u32(reg);
    tx_str(" KB  (0x1FFFF7E0)\r\n");

    tx_str("blob base      : ");
    tx_hex(base);
    tx_str("\r\n");
    tx_str("blob last      : ");
    tx_hex(end);
    tx_str("  size ");
    tx_u32(FLASH_70K_BYTES / 1024u);
    tx_str(" KB\r\n");

    tx_str("blob[0]        : ");
    tx_hex(rd8(&flash_70k_blob[0]));
    tx_str("  (expect 0xA5)\r\n");

    tx_str("blob[last]     : ");
    tx_hex(rd8(&flash_70k_blob[FLASH_70K_BYTES - 1u]));
    tx_str("  (expect 0xA5)\r\n");

    tx_str("tail 4KB match : ");
    tx_u32(tail_ok);
    tx_str(" / ");
    tx_u32(FLASH_70K_TAIL);
    tx_str("\r\n");

    tx_str("word@0x08010000: ");
    tx_hex(probe);
    tx_str("  (expect 0xA5A5A5A5)\r\n");

    tx_str("verdict        : ");
    if ((probe == 0xA5A5A5A5u) && (tail_ok == FLASH_70K_TAIL)) {
        tx_str("128KB OK - 64KB 之外可读写\r\n");
    } else if (probe == 0x20005000u) {
        tx_str("64KB only - 0x08010000 镜像回 0x08000000\r\n");
    } else {
        tx_str("NOT usable above 64KB - 实际容量约 64KB\r\n");
    }
    tx_str("------------------------------------------\r\n\r\n");
}
