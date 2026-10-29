# UI copy and control review

This internal update reviews the renderer's descriptions, empty states and help text without changing the overall workspace structure.

## Changes

- Hardware debugging keeps its disassembly/register/memory panes and execution actions. Repeated PC/SP/target summary cards, data-source badges and storage introductions are removed. The selected runtime, connection state, symbol file and last update remain available in one place each.
- A replacement plugin view owns its controls instead of appearing beneath a second set of inactive native tabs and actions. Unsupported runtimes show one status instead of an unusable native workbench.
- Preferences no longer introduce themselves with a list of what they contain. Installation and driver explanations use optional native dialog help, with keyboard focus restoration and Escape dismissal. Missing package errors and installation output remain visible.
- Compiler catalogs no longer repeat their tab labels or save instructions. AI completion schema details move to help; firmware export keeps the selected format description and its address information without an additional introduction.
- Checkboxes share sizing, checked/disabled/focus states and clickable labels. Windows high-contrast mode uses native checkbox rendering.
- The target-device pane retains `overflow: auto` with hidden scrollbar chrome. Wheel, touch, keyboard and programmatic scrolling stay enabled.

## Retained wording

Error diagnostics, byte/address units, destructive-write confirmations, gap-overwrite warnings, plugin approval warnings, compiler ownership and unverified platform status are retained. Their purpose is to identify an operation or resolve a failure, rather than describe routine controls.

The review includes settings, hardware debugging, target-device status, completion configuration, firmware tools, layout guidance and the shared renderer dictionaries. It does not translate or rewrite compiler output, user project text, terminal output or third-party plugin copy.

## Validation

Lightweight server-rendering tests preserve the debugger panes and connector controls, check that repeated source/summary labels are absent, and check that installation help is available through an accessible dialog trigger. They do not exercise native dialog focus or visual appearance in a running browser.

Manual acceptance should cover dark/light and Windows high-contrast modes, checkbox keyboard/focus behavior, installation help opening/closing, plugin replacement views, target-panel scrolling with hidden scrollbars, and narrow debug-window layouts. No browser or desktop interaction is marked as passed by this document.
