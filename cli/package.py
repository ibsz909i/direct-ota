"""Build a bounded distributable archive. Never print matched credential values."""
import base64
import io
import json
from pathlib import Path
import re
import sys
import zipfile

SECRET_PATTERNS = (
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    rb"sb_secret_[A-Za-z0-9]+",
    rb'"type"\s*:\s*"service_account"',
    rb"AKIA[0-9A-Z]{16}",
    rb"gh[pousr]_[A-Za-z0-9]{30,}",
    rb"sk_live_[A-Za-z0-9]{20,}",
)


def validate_file(name: str, data: bytes) -> None:
    parts = Path(name).parts
    if '\\' in name or ':' in name or name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')):
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


def package(root: Path, destination: Path) -> dict:
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Bundle root must be a regular directory')
    entries = sorted(root.rglob('*'))
    if any(p.is_symlink() for p in entries):
        raise ValueError('Symlinks are not distributable')
    # Vite's build-analysis manifest is used by local budget checks, not the app.
    files = [p for p in entries if p.is_file() and p.relative_to(root).as_posix() != '.vite/manifest.json']
    if len(files) > 1000 or not (root / 'index.html').is_file():
        raise ValueError('Invalid bundle file count or missing index.html')
    size = 0
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            name = path.relative_to(root).as_posix()
            size += path.stat().st_size
            if size > 26214400:
                raise ValueError('Expanded bundle exceeds 25 MiB')
            data = path.read_bytes()
            validate_file(name, data)
            archive.writestr(name, data)
    with destination.open('xb') as file:
        file.write(output.getvalue())
    return {'files': len(files), 'unpackedBytes': size}


if __name__ == '__main__':
    try:
        print(json.dumps(package(Path(sys.argv[1]), Path(sys.argv[2]))))
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
