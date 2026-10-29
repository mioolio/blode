import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeilProject } from '../extensions/boards/stm32/keil';
import { migrateLegacyCmsis } from '../extensions/boards/stm32/cmsis';
const project = `<Project><Targets><Target><TargetName>OLED</TargetName><Device>STM32F103C8</Device><Cads><VariousControls><Define>USE_STDPERIPH_DRIVER</Define><IncludePath>.\\Start;.\\Library</IncludePath></VariousControls></Cads><Groups><Group><Files><File><FilePath>.\\User\\main.c</FilePath></File><File><FilePath>.\\Start\\startup_stm32f10x_md.s</FilePath></File><File><FilePath>.\\Start\\startup_stm32f10x_hd.s</FilePath><FileOption><IncludeInBuild>0</IncludeInBuild></FileOption></File></Files></Group></Groups></Target></Targets></Project>`;
test('Keil build list selects MD startup and dependencies rather than unused startup variants', () => {
  const result = parseKeilProject(project, 'Project.uvprojx');
  assert.deepEqual(result.files, ['User/main.c', 'Start/startup_stm32f10x_md.s']);
  assert.deepEqual(result.defines, ['USE_STDPERIPH_DRIVER']);
  assert.deepEqual(result.includes, ['Start', 'Library']);
});
test('Keil metadata refuses entities, traversal and ambiguous targets', () => {
  assert.throws(() => parseKeilProject('<!DOCTYPE x>' + project, 'p.uvprojx'), /keilProjectInvalid/);
  assert.throws(
    () => parseKeilProject(project.replace('.\\User\\main.c', '..\\main.c'), 'p.uvprojx'),
    /keilProjectPath/,
  );
  assert.throws(
    () => parseKeilProject(project.replace('</Targets>', '<Target/></Targets>'), 'p.uvprojx'),
    /keilTargetAmbiguous/,
  );
});
test('CMSIS compatibility is restricted to the known version and complete helper set', () => {
  assert.equal(migrateLegacyCmsis('int main(void){}'), null);
  assert.equal(
    migrateLegacyCmsis('@version V1.30\n#elif (defined (__GNUC__))\n#elif (defined (__TASKING__))'),
    null,
  );
});
