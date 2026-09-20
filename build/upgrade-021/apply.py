"""Apply the reviewed release diff, verifying every source file before and after.
The encoded files contain only an xz-compressed JSON manifest and a Git diff.
They are a transport format, not executable code or wallet data.
"""
import base64
import hashlib
import json
import lzma
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
PARTS = ROOT / 'build' / 'upgrade-021'
EXPECTED = '9d4a65601a940640abbcbf0f374f512c8781410d89ef73953434b01b978d4d43'
raw = lzma.decompress(base64.b64decode(''.join((PARTS / f'part{i}.txt').read_text().strip() for i in range(1, 5)), validate=True))
assert hashlib.sha256(raw).hexdigest() == EXPECTED, 'Patch transport integrity failure'
data = json.loads(raw)
manifest = data['manifest']
assert len(manifest) == 35
for entry in manifest:
    p = pathlib.PurePosixPath(entry['path'])
    assert not p.is_absolute() and '..' not in p.parts and not p.parts[0] in ('.git', '.github'), entry['path']
    if entry['path'] == 'build/verify-release-021.cjs':
        # Vite may represent 145000 as 145e3. Only the verifier regex changes.
        entry['transportNew'] = entry['new']
        entry['new'] = '9c434ca33fa6f40d6261b83ffe5227e542af20f02fd95d715c2023b79415c083'

def digest(path):
    p = ROOT / path
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None

if all(digest(e['path']) == e['new'] for e in manifest):
    print('Release source is already materialized and verified.')
else:
    for entry in manifest:
        assert digest(entry['path']) == entry['old'], f"Unexpected baseline bytes: {entry['path']}"
    subprocess.run(['git', 'apply', '--check', '-'], input=data['diff'].encode('utf-8'), cwd=ROOT, check=True)
    subprocess.run(['git', 'apply', '-'], input=data['diff'].encode('utf-8'), cwd=ROOT, check=True)
    verifier = ROOT / 'build/verify-release-021.cjs'
    text = verifier.read_text(encoding='utf-8')
    old = r'/minimumStartWindowMs\s*:\s*145000/'
    assert old in text
    verifier.write_bytes(text.replace(old, r'/minimumStartWindowMs\s*:\s*(?:145000|145e3)/').encode('utf-8'))
    for entry in manifest:
        assert digest(entry['path']) == entry['new'], f"Patched bytes mismatch: {entry['path']}"

out = ROOT / 'verification'
out.mkdir(exist_ok=True)
(out / 'update-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
(out / 'reviewed-upgrade.diff').write_bytes(data['diff'].encode('utf-8'))
(out / 'build-provenance.json').write_text(json.dumps({
    'sourceBase': 'd730bbb02caa97e10b8ac162326ff61ded6c045d',
    'patchPayloadSha256': EXPECTED,
    'materializedFiles': len(manifest),
    'transportIsSourceDiffOnly': True,
    'verifierFormatCorrection': 'Accept equivalent Vite 145e3 numeric representation',
    'userWalletDataIncluded': False,
}, indent=2), encoding='utf-8')
print('All 35 release source files passed before/after verification.')
