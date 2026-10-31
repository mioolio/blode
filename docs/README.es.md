# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · **Español** · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio es un entorno modular de desarrollo de sistemas embebidos: edición, compilación y programación de firmware, comunicación serie, depuración de hardware, Git y colaboración. Puede utilizarse como aplicación Electron o desde un navegador conectado a un servidor Node.js en el equipo que contiene los proyectos y el hardware.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## Funciones disponibles

- Autocompletado C/C++, definiciones, referencias, diagnósticos y formato con clangd, con un índice del espacio de trabajo como alternativa; pestañas de vista previa, edición dividida y recuperación de borradores.
- Compilación sin conectar dispositivos: entradas con nombre, Debug/Release, optimización de tamaño y selección independiente de herramientas C y C++.
- Exportación BIN, HEX, S-record y ELF, programación de firmware preparado y proyectos compartidos con dependencias de código externas.
- Búsqueda de bibliotecas Arduino, importación de carpetas o ZIP de componentes y exportación de módulos y herramientas para uso sin conexión.
- Inspección de registros, desensamblado, pila y memoria; ejecución paso a paso y puntos de interrupción por lotes.
- Pestañas, zonas de edición y registros recientes compartidos; fusión de cambios independientes y conservación de conflictos. El navegador solo deshace los cambios del usuario actual.
- Gestión gráfica del historial Git, diferencias, preparación, commits, ramas y remotos; varias terminales nativas e integración con VS Code.
- Vista de imágenes y reproducción de audio/vídeo; autocompletado IA opcional y edición limitada al ámbito seleccionado. Módulos y extensiones mantienen sus recursos y catálogos de idioma.

## Elegir distribución

| Edición             | Requisitos                     | Archivo                                     |
| ------------------- | ------------------------------ | ------------------------------------------- |
| Escritorio portátil | Windows x64; ejecución directa | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Web independiente   | Windows x64; incluye Node.js   | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web con Node.js     | Windows x64; Node.js 24+ x64   | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

Las tres ediciones comparten el formato de proyecto y los servicios. Extraiga el ZIP Node.js y ejecute `start-web.cmd`; incluye las dependencias. El código de `main` puede ser posterior a los paquetes: consulte las notas de la versión descargada.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## Hardware y sistemas compatibles

| Módulo de dispositivo            | Compilación                      | Conexión            |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

Los perfiles actuales cubren ESP32-S3 y STM32F103C8/C8T6. El proyecto configura los pines de cámara. UART GDB de ESP32-S3 se ha probado con una configuración Windows de referencia; continúa la validación de USB-JTAG nativo. Windows x64 es la distribución principal. Las adaptaciones Linux x64/ARM64 y las rutas de herramientas macOS todavía no cuentan con validación completa en equipos reales.

## Inicio rápido

El desarrollo desde las fuentes requiere Node.js 24+, npm y Git.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

Para trabajar en el navegador, ejecute lo siguiente en el equipo del proyecto y del hardware y abra el enlace mostrado. Las carpetas, la compilación, los puertos USB/serie y las terminales pertenecen a ese servidor.

```sh
npm run web:build
npm run web:start
```

## Módulos y aplicaciones binarias

Los módulos separan diez responsabilidades: `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages` y `tools`. `be` guarda la configuración de compilación y `blode.components.json` las bibliotecas. `package:runtime` genera JavaScript, manifiestos y recursos independientes; los hosts binarios y Web compatibles los cargan sin las fuentes TypeScript del programa. Las extensiones generales pueden aportar apariencia, menús, ventanas y paneles sin implementar un compilador.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## Firmas de paquetes

- `obe` es un manifiesto JSON firmado con Ed25519 que vincula editor, ID/versión del paquete y ruta, tamaño y SHA-256 de cada archivo. El contenido real se comprueba de nuevo antes de instalar.
- La confianza oficial procede del registro de claves públicas del host. Se distinguen firmas ausentes o desconocidas, firmas dañadas y archivos modificados. Exportar conserva la firma original, sin otorgar identidad oficial a paquetes de terceros.
- Las claves privadas permanecen en `.signing/`, fuera de Git y de los paquetes. Windows Authenticode es una capa independiente; el certificado actual es autofirmado, no emitido por una autoridad pública. Los contenidos modificados deben firmarse de nuevo.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [Módulos y aplicaciones binarias](ENGINEERING.md)

## Trabajo en curso

- Más hardware, colaboración prolongada y migración de proyectos entre equipos.
- Calidad de las sugerencias IA, métodos de entrada y revisión de términos en cada idioma.
- Validación real de instalación, herramientas y USB en Linux/macOS.

## Documentación

- [Módulos y aplicaciones binarias](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [Firmas de paquetes](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## Licencia y contribuciones

El código se publica bajo Apache License 2.0. Compiladores, controladores y servicios externos conservan sus condiciones. Utilice GitHub Issues y Pull Requests para informar de problemas y aportar mejoras.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
