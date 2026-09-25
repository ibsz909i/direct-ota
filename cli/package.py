"""Build a bounded distributable archive. Never print matched credential values."""
import base64
import io
import json
from pathlib import Path
import re
import sys
import unicodedata
import zipfile

SECRET_PATTERNS = (
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    rb"sb_secret_[A-Za-z0-9]+",
    rb'"type"\s*:\s*"service_account"',
    rb"AKIA[0-9A-Z]{16}",
    rb"gh[pousr]_[A-Za-z0-9]{30,}",
    rb"sk_live_[A-Za-z0-9]{20,}",
)


def validate_file(name: str, data: bytes, scanner: dict) -> None:
    parts = Path(name).parts
    if (len(name.encode('utf-8')) > 1024 or len(name.split('/')) > 32 or
            unicodedata.normalize('NFC', name) != name or
            any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name) or
            '\\' in name or ':' in name or name.startswith('/') or
            any(p in ('', '.', '..') for p in name.split('/'))):
        raise ValueError('Unsafe archive entry path')
    if (any(p.startswith('.') or p in ('fixtures', '__tests__', 'node_modules') for p in parts)
            or Path(name).suffix.lower() in ('.map', '.ts', '.tsx', '.pem', '.key', '.p12', '.pfx')
            or re.search(r'(^|[./_-])(credentials|service-account|service_account)([./_-]|$)', name, re.I)):
        raise ValueError(f'Non-distributable file: {name}')
    if any(re.search(pattern, data) for pattern in SECRET_PATTERNS):
        raise ValueError(f'Credential pattern in: {name}')
    for token in re.findall(rb'eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+', data):
        try:
            payload = json.loads(base64.urlsafe_b64decode(token + b'=' * ((4 - len(token) % 4) % 4)))
        except (ValueError, TypeError):
            continue
        # Public Supabase anon configuration is expected; user/session JWTs are not.
        if not isinstance(payload, dict) or payload.get('role') != 'anon':
            raise ValueError(f'Non-public JWT in: {name}')
    # Explicit file exceptions apply only to project rules, never to the built-in
    # secret and non-distributable checks above.
    if name not in scanner.get('allowFiles', []):
        for literal in scanner.get('deny', []):
            if literal.encode('utf-8') in data:
                raise ValueError(f'Project deny marker in: {name}')


def package(root: Path, destination: Path, scanner=None, limits=None) -> dict:
    scanner = scanner or {}
    limits = limits or {'archiveBytes': 5242880, 'unpackedBytes': 26214400, 'files': 1000}
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Bundle root must be a regular directory')
    files = []
    entries_seen = 0
    for path in root.rglob('*'):
        entries_seen += 1
        if entries_seen > 20000:
            raise ValueError('Bundle has too many entries')
        if path.is_symlink():
            raise ValueError('Symlinks are not distributable')
        if path.is_file() and path.relative_to(root).as_posix() != '.vite/manifest.json':
            files.append(path)
            if len(files) > limits['files']:
                raise ValueError('Invalid bundle file count')
    files.sort()
    # Vite's build-analysis manifest is used by local budget checks, not the app.
    if len(files) > limits['files'] or not (root / 'index.html').is_file():
        raise ValueError('Invalid bundle file count or missing index.html')
    size = 0
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            name = path.relative_to(root).as_posix()
            data = path.read_bytes()
            size += len(data)
            if size > limits['unpackedBytes']:
                raise ValueError('Expanded bundle exceeds configured limit')
            validate_file(name, data, scanner)
            archive.writestr(name, data)
    if len(output.getbuffer()) > limits['archiveBytes']:
        raise ValueError('Compressed bundle exceeds configured limit')
    with destination.open('xb') as file:
        file.write(output.getvalue())
    return {'files': len(files), 'unpackedBytes': size}


if __name__ == '__main__':
    try:
        policy = json.loads(Path(sys.argv[3]).read_text('utf-8')) if len(sys.argv) > 3 else {}
        if not isinstance(policy, dict):
            raise ValueError('Invalid packaging policy')
        scanner = policy.get('scanner', policy)
        limits = policy.get('limits', {'archiveBytes': 5242880, 'unpackedBytes': 26214400, 'files': 1000})
        if (set(policy) - {'scanner', 'limits'} if 'scanner' in policy or 'limits' in policy else set()):
            raise ValueError('Invalid packaging policy')
        if (not isinstance(limits, dict) or set(limits) != {'archiveBytes', 'unpackedBytes', 'files'} or
                any(type(limits[key]) is not int or limits[key] < low or limits[key] > high
                    for key, low, high in (('archiveBytes', 5242880, 52428800),
                                           ('unpackedBytes', 26214400, 104857600), ('files', 1000, 5000))) or
                limits['unpackedBytes'] < limits['archiveBytes']):
            raise ValueError('Invalid packaging limits')
        if (not isinstance(scanner, dict) or set(scanner) - {'deny', 'allowFiles'} or
                any(not isinstance(scanner.get(key, []), list) or len(scanner.get(key, [])) > 20 or
                    any(not isinstance(item, str) or not item or len(item) > 128 for item in scanner.get(key, []))
                    for key in ('deny', 'allowFiles'))):
            raise ValueError('Invalid scanner policy')
        print(json.dumps(package(Path(sys.argv[1]), Path(sys.argv[2]), scanner, limits)))
    except (ValueError, OSError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
