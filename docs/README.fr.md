# Blode Studio

[简体中文](../README.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Français** · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md)

Blode Studio est un environnement modulaire de développement embarqué : édition du code, compilation et programmation du micrologiciel, communication série, débogage matériel, Git et collaboration. Utilisez l’application Electron ou une interface Web reliée à un hôte Node.js sur l’ordinateur qui possède les projets et le matériel.

[GitHub Releases](https://github.com/mioolio/blode/releases) · [CHANGELOG](../CHANGELOG.md) · [Issues](https://github.com/mioolio/blode/issues)

## Fonctionnalités disponibles

- Complétion C/C++, définitions, références, diagnostics et formatage avec clangd, avec index de l’espace de travail en repli ; onglets d’aperçu, vues fractionnées et récupération des brouillons.
- Compilation sans matériel connecté : points d’entrée nommés, modes Debug/Release, optimisation de taille et choix distinct des outils C et C++.
- Export BIN, HEX, S-record et ELF ; programmation de fichiers déjà compilés et partage des projets avec leurs dépendances sources externes.
- Recherche de bibliothèques Arduino, import de dossiers ou de ZIP de composants, export de modules matériels et de chaînes d’outils hors ligne.
- Inspection des registres, du désassemblage, de la pile et de la mémoire ; exécution pas à pas et ajout groupé de points d’arrêt.
- Partage des onglets, des zones de travail et des journaux récents ; fusion des modifications indépendantes et conservation des conflits. Dans le navigateur, l’annulation porte sur ses propres modifications.
- Gestion graphique de Git : historique, différences, index, commits, branches et dépôts distants ; terminaux natifs multiples et connexion à VS Code.
- Aperçu des images, lecture audio et vidéo ; complétion IA facultative et modifications limitées au périmètre choisi. Les modules et extensions gèrent leurs propres ressources et traductions.

## Choisir une distribution

| Édition          | Environnement                  | Fichier                                     |
| ---------------- | ------------------------------ | ------------------------------------------- |
| Bureau portable  | Windows x64 ; lancement direct | `Blode.Studio-0.3.5.9-desktop-win-x64.exe`  |
| Web autonome     | Windows x64 ; Node.js inclus   | `Blode.Studio-0.3.5.9-web-win-x64.exe`      |
| Web avec Node.js | Windows x64 ; Node.js 24+ x64  | `Blode.Studio-0.3.5.9-web-node-win-x64.zip` |

Les trois éditions partagent le format de projet et les services hôtes. Décompressez le ZIP Node.js et lancez `start-web.cmd` ; les dépendances sont incluses. Le code de `main` peut être plus récent que les paquets : consultez les notes de version pour les téléchargements.

[0.3.5.9](releases/0.3.5.9.md) · [SHA-256 / OBE](PACKAGE-SIGNING.md)

## Matériel et systèmes hôtes

| Module matériel                  | Outils de compilation            | Connexion matérielle |
| -------------------------------- | -------------------------------- | -------------------- |
| Esp32_S3_CAM · ESP32-S3          | Arduino CLI + Arduino-ESP32      | UART / USB-JTAG      |
| STM32F103C8T6 · STM32F103C8/C8T6 | GNU Arm GCC / Arm Compiler 5 / 6 | ST-Link / SWD / GDB  |

Les profils actuels couvrent ESP32-S3 et STM32F103C8/C8T6. Les broches caméra sont définies par le projet. UART GDB sur ESP32-S3 a été testé dans une configuration Windows de référence ; la validation USB-JTAG native continue. Windows x64 est la distribution principale. Les adaptations Linux x64/ARM64 et les chemins d’outils macOS ne sont pas encore entièrement validés sur machines réelles.

## Démarrage rapide

Le développement depuis les sources nécessite Node.js 24+, npm et Git.

```sh
git clone --single-branch https://github.com/mioolio/blode.git
cd blode
npm ci
npm run dev
```

Pour utiliser le navigateur, exécutez ces commandes sur l’ordinateur contenant les projets et le matériel, puis ouvrez le lien affiché. Les dossiers, la compilation, les ports USB/série et les terminaux appartiennent à cet ordinateur hôte.

```sh
npm run web:build
npm run web:start
```

## Modules et hôtes binaires

Les modules matériels séparent dix responsabilités : `support`, `device`, `runtime`, `constraints`, `ui`, `compiler`, `debugger`, `layout`, `languages` et `tools`. `be` contient les entrées de compilation ; `blode.components.json` décrit les bibliothèques du projet. `package:runtime` produit JavaScript, manifestes et ressources autonomes, chargeables par un hôte binaire ou Web compatible sans les sources TypeScript de l’hôte. Les extensions générales peuvent ajouter apparence, menus, fenêtres et panneaux sans implémenter de compilation.

```sh
npm run package:runtime -- extensions/boards/Esp32_S3_CAM --output ./release/modules --zip
```

## Signatures des paquets

- `obe` est un manifeste JSON signé par Ed25519 : éditeur, ID/version du paquet, chemin, taille et SHA-256 de chaque fichier. Le contenu réel est vérifié à nouveau avant l’installation.
- La confiance officielle dépend du registre de clés publiques de l’hôte. Les signatures absentes ou inconnues, les signatures endommagées et les contenus modifiés sont distingués. L’export préserve une signature existante sans attribuer une identité officielle aux paquets tiers.
- Les clés privées restent dans `.signing/`, hors de Git et des distributions. Windows Authenticode constitue une couche séparée ; le certificat actuel est autosigné, non délivré par une autorité publique. Un contenu signé modifié doit être signé à nouveau.

[OBE / Authenticode](PACKAGE-SIGNING.md) · [Modules et hôtes binaires](ENGINEERING.md)

## Travaux en cours

- Élargissement du matériel testé, collaboration prolongée et migration de projets entre ordinateurs.
- Qualité des suggestions IA, méthodes de saisie et révision de la terminologie multilingue.
- Validation réelle de l’installation, des outils et de l’USB sous Linux/macOS.

## Documentation

- [Modules et hôtes binaires](ENGINEERING.md) · [Runtime plugins](RUNTIME-PLUGINS.md) · [General extensions](GENERAL-EXTENSIONS.md)
- [Projects](PROJECTS.md) · [Component libraries](COMPONENT-LIBRARIES.md) · [Offline delivery](OFFLINE-DELIVERY.md)
- [Signatures des paquets](PACKAGE-SIGNING.md) · [Build / Release](RELEASING.md) · [Localization](LOCALIZATION.md)
- [Hardware debugging](HARDWARE-DEBUGGING.md) · [Platforms](PLATFORM-SUPPORT.md) · [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)

## Licence et contributions

Les sources sont publiées sous Apache License 2.0. Les compilateurs, pilotes et services tiers conservent leurs propres conditions. Les rapports et contributions sont reçus via GitHub Issues et Pull Requests.

[Apache License 2.0](../LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
