/** The built-in startup is deliberately restricted to the probed STM32F1 medium-density profile. */
export const F1_MEDIUM_DENSITY = {
  chipId: 0x410,
  cpu: 'cortex-m3',
  ramSize: 20 * 1024,
  stackSize: 1024,
} as const;

const coreVectors = [
  'NMI_Handler',
  'HardFault_Handler',
  'MemManage_Handler',
  'BusFault_Handler',
  'UsageFault_Handler',
  '0',
  '0',
  '0',
  '0',
  'SVC_Handler',
  'DebugMon_Handler',
  '0',
  'PendSV_Handler',
  'SysTick_Handler',
];
const interrupts = [
  'WWDG_IRQHandler',
  'PVD_IRQHandler',
  'TAMPER_IRQHandler',
  'RTC_IRQHandler',
  'FLASH_IRQHandler',
  'RCC_IRQHandler',
  'EXTI0_IRQHandler',
  'EXTI1_IRQHandler',
  'EXTI2_IRQHandler',
  'EXTI3_IRQHandler',
  'EXTI4_IRQHandler',
  'DMA1_Channel1_IRQHandler',
  'DMA1_Channel2_IRQHandler',
  'DMA1_Channel3_IRQHandler',
  'DMA1_Channel4_IRQHandler',
  'DMA1_Channel5_IRQHandler',
  'DMA1_Channel6_IRQHandler',
  'DMA1_Channel7_IRQHandler',
  'ADC1_2_IRQHandler',
  'USB_HP_CAN1_TX_IRQHandler',
  'USB_LP_CAN1_RX0_IRQHandler',
  'CAN1_RX1_IRQHandler',
  'CAN1_SCE_IRQHandler',
  'EXTI9_5_IRQHandler',
  'TIM1_BRK_IRQHandler',
  'TIM1_UP_IRQHandler',
  'TIM1_TRG_COM_IRQHandler',
  'TIM1_CC_IRQHandler',
  'TIM2_IRQHandler',
  'TIM3_IRQHandler',
  'TIM4_IRQHandler',
  'I2C1_EV_IRQHandler',
  'I2C1_ER_IRQHandler',
  'I2C2_EV_IRQHandler',
  'I2C2_ER_IRQHandler',
  'SPI1_IRQHandler',
  'SPI2_IRQHandler',
  'USART1_IRQHandler',
  'USART2_IRQHandler',
  'USART3_IRQHandler',
  'EXTI15_10_IRQHandler',
  'RTCAlarm_IRQHandler',
  'USBWakeUp_IRQHandler',
  'TIM8_BRK_IRQHandler',
  'TIM8_UP_IRQHandler',
  'TIM8_TRG_COM_IRQHandler',
  'TIM8_CC_IRQHandler',
  'ADC3_IRQHandler',
  'FSMC_IRQHandler',
  'SDIO_IRQHandler',
  'TIM5_IRQHandler',
  'SPI3_IRQHandler',
  'UART4_IRQHandler',
  'UART5_IRQHandler',
  'TIM6_IRQHandler',
  'TIM7_IRQHandler',
  'DMA2_Channel1_IRQHandler',
  'DMA2_Channel2_IRQHandler',
  'DMA2_Channel3_IRQHandler',
  'DMA2_Channel4_5_IRQHandler',
];

export function createF1Ac5Startup(): string {
  const handlers = [...coreVectors, ...interrupts].filter((name) => name !== '0');
  return `        PRESERVE8
        THUMB
        AREA |.isr_vector|, DATA, READONLY
        EXPORT __Vectors
__Vectors
        DCD 0x20005000
        DCD Reset_Handler
${[...coreVectors, ...interrupts].map((name) => `        DCD ${name}`).join('\n')}
        AREA |.text|, CODE, READONLY
        IMPORT __main
        EXPORT Reset_Handler
Reset_Handler PROC
        BL SystemInit
        B __main
        ENDP
SystemInit PROC
        EXPORT SystemInit [WEAK]
        BX LR
        ENDP
Default_Handler PROC
${handlers.map((name) => `        EXPORT ${name} [WEAK]`).join('\n')}
${handlers.join('\n')}
        B .
        ENDP
        END
`;
}

export function createF1Startup(): string {
  const handlers = [...coreVectors, ...interrupts].filter((name) => name !== '0');
  return `/* Generated for STM32F1 medium density (chip ID 0x410), Cortex-M3, 20 KiB RAM. */
#include <stdint.h>
extern void __main(void) __attribute__((noreturn));
extern void SystemInit(void) __attribute__((weak));
void Default_Handler(void) { for (;;) { __asm volatile ("nop"); } }
${handlers.map((name) => `void ${name}(void) __attribute__((weak, alias("Default_Handler")));`).join('\n')}
void Reset_Handler(void) {
  /* AC6 __main performs scatter loading, RW/ZI initialization and C++ constructors. */
  if (SystemInit) SystemInit();
  __main();
}
__attribute__((used, aligned(4), section(".isr_vector")))
const uintptr_t g_pfnVectors[] = {
  0x20005000u, (uintptr_t)Reset_Handler,
  ${[...coreVectors, ...interrupts].map((name) => (name === '0' ? '0' : `(uintptr_t)${name}`)).join(',\n  ')}
};
`;
}

export function createF1Scatter(appSize: number, firmwareTag = false, nativeStartup = false): string {
  return `; Generated only for the identified STM32F1 medium-density target.
LR_FLASH 0x08000000 0x${appSize.toString(16)} {
  ER_FLASH 0x08000000 0x${appSize.toString(16)} {
    * (${nativeStartup ? 'RESET' : '.isr_vector'}, +First)
${firmwareTag ? '    * (.fwtag)\n' : ''}
    * (InRoot$$Sections)
    .ANY (+RO)
  }
  RW_RAM 0x20000000 ${nativeStartup ? '0x5000' : '0x4c00'} {
    .ANY (+RW +ZI)
  }
  ; The descending stack owns the top 1 KiB; RW/ZI cannot grow into it.
${nativeStartup ? '' : '  ARM_LIB_STACK 0x20005000 EMPTY -0x400 { }'}
}
`;
}

/** GNU Arm startup for the same F1 medium-density profile; runs libc init before main. */
export function createF1GnuStartup(): string {
  const handlers = [...coreVectors, ...interrupts].filter((name) => name !== '0');
  return `/* Generated for STM32F1 medium density (chip ID 0x410), Cortex-M3, 20 KiB RAM. */
#include <stdint.h>
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss, _estack;
extern int main(void);
extern void __libc_init_array(void);
extern void SystemInit(void) __attribute__((weak));
void Default_Handler(void) { for (;;) { __asm volatile ("nop"); } }
${handlers.map((name) => `void ${name}(void) __attribute__((weak, alias("Default_Handler")));`).join('\n')}
void Reset_Handler(void) {
  uint32_t *source = &_sidata;
  for (uint32_t *target = &_sdata; target < &_edata;) *target++ = *source++;
  for (uint32_t *target = &_sbss; target < &_ebss;) *target++ = 0;
  if (SystemInit) SystemInit();
  __libc_init_array();
  main();
  for (;;) { __asm volatile ("nop"); }
}
__attribute__((used, aligned(4), section(".isr_vector")))
void (* const g_pfnVectors[])(void) = {
  (void (*)(void))(&_estack), Reset_Handler,
  ${[...coreVectors, ...interrupts].map((name) => (name === '0' ? '0' : `(void (*)(void))${name}`)).join(',\n  ')}
};
`;
}

/** GNU linker script mirrors the scatter layout so partitions and usage checks stay authoritative. */
export function createF1GnuLinkerScript(appSize: number, firmwareTag = false): string {
  return `/* Generated only for the identified STM32F1 medium-density target. */
ENTRY(Reset_Handler)
MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 0x${appSize.toString(16)}
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = ${F1_MEDIUM_DENSITY.ramSize}
}
_estack = ORIGIN(RAM) + LENGTH(RAM);
_Min_Stack_Size = 0x400;
SECTIONS
{
  .isr_vector :
  {
    . = ALIGN(4);
    KEEP(*(.isr_vector))
    . = ALIGN(4);
  } > FLASH
  .text :
  {
    . = ALIGN(4);
    *(.text)
    *(.text*)
    *(.glue_7)
    *(.glue_7t)
    *(.eh_frame)
    KEEP(*(.init))
    KEEP(*(.fini))
    . = ALIGN(4);
  } > FLASH
  .rodata :
  {
    . = ALIGN(4);
    *(.rodata)
    *(.rodata*)
    . = ALIGN(4);
  } > FLASH
  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } > FLASH
  .ARM :
  {
    __exidx_start = .;
    *(.ARM.exidx*)
    __exidx_end = .;
  } > FLASH
  .preinit_array :
  {
    PROVIDE_HIDDEN(__preinit_array_start = .);
    KEEP(*(.preinit_array*))
    PROVIDE_HIDDEN(__preinit_array_end = .);
  } > FLASH
  .init_array :
  {
    PROVIDE_HIDDEN(__init_array_start = .);
    KEEP(*(SORT(.init_array.*)))
    KEEP(*(.init_array*))
    PROVIDE_HIDDEN(__init_array_end = .);
  } > FLASH
  .fini_array :
  {
    PROVIDE_HIDDEN(__fini_array_start = .);
    KEEP(*(SORT(.fini_array.*)))
    KEEP(*(.fini_array*))
    PROVIDE_HIDDEN(__fini_array_end = .);
  } > FLASH
  _sidata = LOADADDR(.data);
  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data)
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > RAM AT > FLASH
  .bss :
  {
    . = ALIGN(4);
    _sbss = .;
    *(.bss)
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > RAM
  ._user_heap_stack (NOLOAD) :
  {
    . = ALIGN(8);
    PROVIDE(end = .);
    PROVIDE(_end = .);
    . = . + _Min_Stack_Size;
    . = ALIGN(8);
  } > RAM
${firmwareTag ? '  .fwtag : { KEEP(*(.fwtag)) } > FLASH\n' : ''}
}
ASSERT(_ebss <= ORIGIN(RAM) + LENGTH(RAM) - _Min_Stack_Size, "RAM overflow")
`;
}
