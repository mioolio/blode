# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · **العربية** · [हिन्दी](README.hi.md)

Blode Studio بيئة تطوير معيارية للأنظمة المضمّنة تجمع تحرير الشيفرة وبناء البرامج الثابتة وكتابتها، والاتصال التسلسلي، وتصحيح الأجهزة، وGit والعمل الجماعي. يمكن استخدام تطبيق Electron المكتبي أو متصفح متصل بخادم Node.js على الكمبيوتر الذي يحتوي على المشاريع والأجهزة.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## الميزات المتاحة

- إكمال C/C++ والانتقال إلى التعريفات والمراجع والتشخيص والتنسيق عبر clangd، مع فهرس بديل لمساحة العمل، وتبويبات معاينة وتحرير منقسم واستعادة المسودات.
- البناء دون توصيل جهاز: نقاط دخول مسمّاة، ووضعا Debug/Release، وتحسين الحجم، واختيار أدوات C وC++ كلٍّ على حدة.
- تصدير BIN وHEX وS-record وELF، وكتابة برامج ثابتة جاهزة، ومشاركة المشاريع مع اعتماديات الشيفرة الخارجية.
- البحث في مكتبات Arduino واستيراد مجلدات المكوّنات أو ZIP وتصدير وحدات الأجهزة وسلاسل الأدوات للاستخدام دون اتصال.
- فحص السجلات والتفكيك ومكدس الاستدعاءات والذاكرة، وتنفيذ خطوات منفردة وإضافة نقاط توقف دفعة واحدة على الجهاز المتصل.
- مشاركة التبويبات ومناطق التحرير وأحدث السجلات، ودمج التغييرات المستقلة مع الاحتفاظ بالتعارضات. يقتصر التراجع في المتصفح على تغييرات المستخدم نفسه.
- إدارة Git رسوميًا: السجل والفروق والتجهيز والالتزامات والفروع والمستودعات البعيدة، مع جلسات طرفية أصلية متعددة واتصال VS Code.
- معاينة الصور وتشغيل الصوت والفيديو، وإكمال اختياري بالذكاء الاصطناعي وتعديلات ضمن النطاق المختار. تحتفظ الوحدات والإضافات بمواردها وكتالوجات لغاتها الخاصة.

## اختيار التوزيعة

| النسخة               | بيئة التشغيل                       | الملف                                       |
| -------------------- | ---------------------------------- | ------------------------------------------- |
| نسخة مكتبية محمولة   | Windows x64، تشغيل مباشر           | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Web مستقلة           | Windows x64، تتضمن Node.js         | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web باستخدام Node.js | Windows x64، تتطلب Node.js 24+ x64 | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

تستخدم النسخ الثلاث تنسيق المشروع وخدمات المضيف نفسها. فك ضغط ZIP الخاص بـ Node.js وشغّل `start-web.cmd`؛ الاعتماديات مضمنة. قد تكون شيفرة `main` أحدث من حزم التنزيل؛ راجع ملاحظات الإصدار لمعرفة محتويات الحزمة.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## الأجهزة والأنظمة المدعومة

| وحدة الجهاز                      | أدوات البناء                     | الاتصال             |
| -------------------------------- | -------------------------------- | ------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG     |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB |

تغطي ملفات التعريف الحالية ESP32-S3 وSTM32F103C8/C8T6. تُضبط أطراف الكاميرا في المشروع. اختُبر UART GDB لـ ESP32-S3 على إعداد Windows مرجعي، ويستمر التحقق من USB-JTAG الأصلي. Windows x64 هو بيئة التوزيع الرئيسية. لم يكتمل التحقق العملي من تكييف Linux x64/ARM64 أو مسارات الأدوات المخصصة في macOS.

## البدء السريع

يتطلب التطوير من المصدر Node.js 24+ وnpm وGit.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

لاستخدام واجهة المتصفح، نفّذ الأوامر التالية على الكمبيوتر الذي يحتوي على المشروع والأجهزة وافتح الرابط المطبوع. يتم اختيار المجلدات والبناء وتشغيل USB والمنافذ التسلسلية والطرفيات على ذلك المضيف.

```sh
npm run web:build
npm run web:start
```

## الوحدات والمضيفات الثنائية

تفصل وحدات الأجهزة عشر مسؤوليات: `support` و`device` و`runtime` و`constraints` و`ui` و`compiler` و`debugger` و`layout` و`languages` و`tools`. يحفظ `be` مدخلات البناء، ويسجل `blode.components.json` مكتبات المشروع. ينتج `package:runtime` شيفرة JavaScript وبيانات تعريف وموارد مستقلة يمكن للمضيفات الثنائية وWeb المتوافقة تحميلها دون مصدر TypeScript للمضيف. تستطيع الإضافات العامة إضافة المظهر والقوائم والنوافذ واللوحات السفلية دون تنفيذ مترجم.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## توقيعات الحزم

- `obe` بيان JSON موقّع بـ Ed25519 يربط الناشر ومعرّف الحزمة وإصدارها بمسار كل ملف وحجمه وSHA-256. يُفحص المحتوى الفعلي مجددًا قبل تثبيته.
- تأتي الثقة الرسمية من سجل المفاتيح العامة في المضيف. يُميَّز بين غياب التوقيع أو ناشر غير معروف، وتلف التوقيع، وتغيّر المحتوى. يحتفظ التصدير بالتوقيع الموجود ولا يمنح حزمة خارجية هوية رسمية.
- تبقى المفاتيح الخاصة في `.signing/` خارج Git وحزم التوزيع. Windows Authenticode طبقة منفصلة؛ الشهادة الحالية ذاتية التوقيع وليست صادرة عن جهة تصديق عامة. يتطلب تعديل المحتوى الموقّع توقيعًا جديدًا.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [الوحدات والمضيفات الثنائية](ENGINEERING.md)

## العمل الجاري

- توسيع اختبارات الأجهزة، والتعاون طويل المدة، ونقل المشاريع بين أجهزة الكمبيوتر.
- تحسين اقتراحات الذكاء الاصطناعي وطرق الإدخال ومراجعة مصطلحات اللغات.
- التحقق العملي من التثبيت والأدوات وUSB على Linux وmacOS.

## التوثيق

- [الوحدات والمضيفات الثنائية](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [توقيعات الحزم](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## الترخيص والمساهمة

تُنشر الشيفرة وفق Apache License 2.0. تحتفظ المترجمات وبرامج التشغيل والخدمات الخارجية بشروطها الخاصة. يمكن إرسال المشكلات والتحسينات عبر GitHub Issues وPull Requests.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
