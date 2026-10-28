/**
 * @file    stm32f103_min.h
 * @brief   STM32F103 (medium density) 最小寄存器定义
 *
 * 只包含测试程序用到的外设，不依赖 CMSIS / HAL / SPL。
 */
#ifndef STM32F103_MIN_H
#define STM32F103_MIN_H

#include <stdint.h>

#define REG32(addr)      (*(volatile uint32_t *)(uintptr_t)(addr))
#define BIT(n)           (1UL << (n))

/* ---------------- RCC ---------------- */
#define RCC_BASE         0x40021000UL
#define RCC_CR           REG32(RCC_BASE + 0x00)
#define RCC_CFGR         REG32(RCC_BASE + 0x04)
#define RCC_CIR          REG32(RCC_BASE + 0x08)
#define RCC_APB2ENR      REG32(RCC_BASE + 0x18)
#define RCC_APB1ENR      REG32(RCC_BASE + 0x1C)
#define RCC_BDCR         REG32(RCC_BASE + 0x20)
#define RCC_CSR          REG32(RCC_BASE + 0x24)

#define RCC_CR_HSION     BIT(0)
#define RCC_CR_HSIRDY    BIT(1)
#define RCC_CR_HSEON     BIT(16)
#define RCC_CR_HSERDY    BIT(17)
#define RCC_CR_PLLON     BIT(24)
#define RCC_CR_PLLRDY    BIT(25)

#define RCC_APB2ENR_AFIOEN   BIT(0)
#define RCC_APB2ENR_IOPAEN   BIT(2)
#define RCC_APB2ENR_IOPBEN   BIT(3)
#define RCC_APB2ENR_IOPCEN   BIT(4)
#define RCC_APB2ENR_USART1EN BIT(14)

/* ---------------- FLASH ---------------- */
#define FLASH_ACR             REG32(0x40022000UL)
#define FLASH_ACR_LATENCY_2   0x2UL
#define FLASH_ACR_PRFTBE      BIT(4)

/* ---------------- GPIO ---------------- */
#define GPIOA_BASE       0x40010800UL
#define GPIOB_BASE       0x40010C00UL
#define GPIOC_BASE       0x40011000UL

typedef struct {
    volatile uint32_t CRL;
    volatile uint32_t CRH;
    volatile uint32_t IDR;
    volatile uint32_t ODR;
    volatile uint32_t BSRR;
    volatile uint32_t BRR;
    volatile uint32_t LCKR;
} GPIO_TypeDef;

#define GPIOA            ((GPIO_TypeDef *)GPIOA_BASE)
#define GPIOB            ((GPIO_TypeDef *)GPIOB_BASE)
#define GPIOC            ((GPIO_TypeDef *)GPIOC_BASE)

/* ---------------- USART1 ---------------- */
typedef struct {
    volatile uint32_t SR;
    volatile uint32_t DR;
    volatile uint32_t BRR;
    volatile uint32_t CR1;
    volatile uint32_t CR2;
    volatile uint32_t CR3;
    volatile uint32_t GTPR;
} USART_TypeDef;

#define USART1           ((USART_TypeDef *)0x40013800UL)
#define USART_SR_TXE     BIT(7)
#define USART_SR_TC      BIT(6)
#define USART_SR_RXNE    BIT(5)
#define USART_CR1_RE     BIT(2)
#define USART_CR1_TE     BIT(3)
#define USART_CR1_UE     BIT(13)

/* ---------------- SysTick / SCB ---------------- */
typedef struct {
    volatile uint32_t CTRL;
    volatile uint32_t LOAD;
    volatile uint32_t VAL;
    volatile uint32_t CALIB;
} SysTick_Type;

#define SysTick          ((SysTick_Type *)0xE000E010UL)
#define SYSTICK_CTRL_ENABLE    BIT(0)
#define SYSTICK_CTRL_TICKINT   BIT(1)
#define SYSTICK_CTRL_CLKSOURCE BIT(2)
#define SYSTICK_CTRL_COUNTFLAG BIT(16)

#define SCB_AIRCR        REG32(0xE000ED0CUL)
#define NVIC_ISER        ((volatile uint32_t *)0xE000E100UL)

/* CPU 时钟，启动时由 clock_init() 更新 */
extern uint32_t SystemCoreClock;

void     SystemInit(void);
void     SystemCoreClockUpdate(void);
uint32_t clock_init(void);

#endif /* STM32F103_MIN_H */
