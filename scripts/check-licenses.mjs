// 许可门禁：校验 vendor/manifest.json 的文件、哈希、许可证与 NOTICE。
// 仍是工程检查，不是法律意见；不联网。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'lib', 'vendor');
const manifestFile = path.join(vendorDir, 'manifest.json');
const forbidden = /(^|\s)(A?GPL|UNLICENSED|NOASSERTION)(\s|$|-)/i;

if (!existsSync(manifestFile)) {
  console.error('missing lib/vendor/manifest.json');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
  console.error('manifest.packages is empty');
  process.exit(1);
}

let failed = 0;
for (const pkg of manifest.packages) {
  const label = `${pkg.name}@${pkg.version}`;
  if (!pkg.license || forbidden.test(pkg.license)) {
    console.error(`${label}: forbidden/empty license ${pkg.license || '<empty>'}`);
    failed += 1;
  }
  if (!pkg.upstream) {
    console.error(`${label}: missing upstream`);
    failed += 1;
  }
  if (pkg.notice && !existsSync(path.join(root, 'THIRD_PARTY_NOTICES.md'))) {
    console.error(`${label}: notice required but THIRD_PARTY_NOTICES.md missing`);
    failed += 1;
  }
  for (const file of pkg.files || []) {
    const target = path.join(vendorDir, pkg.name, file.path);
    if (!existsSync(target)) {
      console.error(`${label}: missing ${file.path}`);
      failed += 1;
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== file.sha256) {
      console.error(`${label}: hash mismatch ${file.path}`);
      failed += 1;
    }
  }
}

if (failed) {
  console.error(`license check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log(`license check passed: ${manifest.packages.length} package(s), ${manifest.packages.reduce((n, pkg) => n + (pkg.files || []).length, 0)} file(s)`);
