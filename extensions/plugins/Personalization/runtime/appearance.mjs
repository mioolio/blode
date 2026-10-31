// Runs inside the extension frame. It has no Node.js or workbench DOM access.
let context;
const t = (key) => context.locales[context.locale]?.[key] ?? context.locales.en?.[key] ?? key;
const display = () => {
  document.documentElement.lang = context.locale ?? 'en';
  document.documentElement.dir = context.locale === 'ar' ? 'rtl' : 'ltr';
  for (const element of document.querySelectorAll('[data-label]'))
    element.textContent = t(element.dataset.label);
  const toggle = document.getElementById('desktop-glass');
  if (toggle) {
    toggle.checked = context.settings.desktopGlass === true;
    toggle.disabled = false;
  }
  const container = document.getElementById('presets');
  container.replaceChildren();
  for (const preset of context.manifest.ui.presets) {
    const button = document.createElement('button');
    button.className = `preset ${preset.id}${context.settings.preset === preset.id ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(context.settings.preset === preset.id));
    const preview = document.createElement('span');
    preview.className = 'sample';
    preview.append(
      Object.assign(document.createElement('i'), { className: 'sample-sidebar' }),
      Object.assign(document.createElement('i'), { className: 'sample-editor' }),
    );
    button.append(
      preview,
      Object.assign(document.createElement('strong'), { textContent: t(`preset.${preset.id}`) }),
    );
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        context = await window.blodeExtension.configure({ preset: preset.id });
        display();
        document.getElementById('status').textContent = t('applied');
      } catch (error) {
        document.getElementById('status').textContent = error.message;
        button.disabled = false;
      }
    });
    container.append(button);
  }
};
export async function start() {
  context = await window.blodeExtension.context();
  display();
  const toggle = document.getElementById('desktop-glass');
  if (toggle)
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        context = await window.blodeExtension.configure({ desktopGlass: toggle.checked });
        display();
        document.getElementById('status').textContent = t('applied');
      } catch (error) {
        toggle.checked = context.settings.desktopGlass === true;
        toggle.disabled = false;
        document.getElementById('status').textContent = error.message;
      }
    });
  document.getElementById('preview').addEventListener('click', async () => {
    try {
      await window.blodeExtension.openView(document.querySelector('.compact') ? 'appearance' : 'preview');
    } catch (error) {
      document.getElementById('status').textContent = error.message;
    }
  });
}
void start().catch((error) => {
  document.getElementById('status').textContent = error.message;
});
