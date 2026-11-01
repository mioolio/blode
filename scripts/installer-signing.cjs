const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
exports.afterSign = async (context) => {
  if (process.env.BLODE_PROTECTED !== '1') return;
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', path.join(__dirname, 'sign-distribution.ts'), context.appOutDir],
    { cwd: path.resolve(__dirname, '..'), windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
};
