#!/usr/bin/env python3
# Copyright (c) 2026 Phosphoros Research and contributors.
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Check an explicit public inventory without printing matched secret values."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCAL_ONLY_DIRS = frozenset({
    '.git', '.aws', '.codex', '.agents', 'rollback-artifacts', 'dist',
    'node_modules', 'coverage', 'test-results',
})


def inventory():
    data = json.loads((ROOT / 'release-files.json').read_text())
    for group in ('source', 'extension'):
        names = data[group]
        assert names == sorted(set(names)), f'{group} inventory is not sorted/unique'
        for name in names:
            p = PurePosixPath(name)
            assert not p.is_absolute() and '..' not in p.parts and '\\' not in name, 'Unsafe archive path'
            assert not any(part in LOCAL_ONLY_DIRS for part in p.parts), 'Private directory in inventory'
            assert not p.name.startswith('.env') and not name.endswith(('.bundle', '.encrypted.json', '.log')), 'Private file in inventory'
            path = ROOT / name
            assert path.is_file(), f'Missing release file: {name}'
            assert not any(parent.is_symlink() for parent in [path, *path.parents] if parent != ROOT.parent), 'Symlink in release path'
            assert path.resolve().is_relative_to(ROOT), 'Release path escapes root'
    assert set(data['extension']) <= set(data['source']), 'Extension inventory is not a source subset'
    return data


def check():
    data = inventory()
    expected = set(data['source'])
    actual = set()
    # Local rollback archives and tool state are never traversed or packaged.
    # Unknown source files still fail the inventory check; exclusions cannot
    # override the explicit private-directory rejection in inventory().
    for directory, dirs, files in os.walk(ROOT, followlinks=False):
        parent = Path(directory)
        for name in list(dirs):
            path = parent / name
            if name == '__pycache__' or (parent == ROOT and name in LOCAL_ONLY_DIRS):
                dirs.remove(name)
            elif path.is_symlink():
                actual.add(path.relative_to(ROOT).as_posix())
                dirs.remove(name)
        actual.update((parent / name).relative_to(ROOT).as_posix() for name in files)
    assert actual == expected, f'Inventory mismatch: extra={sorted(actual-expected)} missing={sorted(expected-actual)}'
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert manifest['name'] == 'Threadlamp' and manifest['author'] == 'Phosphoros Research'
    assert re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', manifest['version'])
    assert set(manifest['permissions']) == {'activeTab', 'storage', 'offscreen', 'scripting', 'alarms'}
    assert set(manifest['host_permissions']) == {'https://chatgpt.com/*', 'https://chat.openai.com/*'}
    assert set(manifest['optional_host_permissions']) == {'http://*/*', 'https://*/*'}
    assert not any(k in manifest for k in ('key', 'update_url', 'externally_connectable'))
    refs = [manifest['background']['service_worker'], manifest['action']['default_popup'], manifest['options_ui']['page']]
    refs += list(manifest['icons'].values()) + list(manifest['action']['default_icon'].values())
    for script in manifest['content_scripts']:
        refs += script.get('js', []) + script.get('css', [])
    extension = set(data['extension'])
    for name in extension:
        if name.endswith('.html'):
            content = (ROOT/name).read_text()
            for ref in re.findall(r'(?:src|href)="([^"]+)"', content):
                assert not re.match(r'https?://', ref), f'Remote UI resource in {name}'
                if not ref.startswith('#'):
                    refs.append((PurePosixPath(name).parent/ref).as_posix())
        if name.endswith('.js'):
            content = (ROOT/name).read_text()
            for call in re.findall(r'importScripts\(([^)]+)\)', content):
                refs += re.findall(r'"([^"]+)"', call)
    assert set(refs) <= extension, f'Missing runtime references: {sorted(set(refs)-extension)}'
    patterns = {
        'private_key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
        'github_token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
        'api_token': re.compile(r'\bsk-[A-Za-z0-9_-]{32,}'),
        'jwt': re.compile(r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}'),
        'home_path': re.compile(r'/(?:home|Users)/[A-Za-z0-9_.-]+/'),
        'aws_key': re.compile(r'\bAKIA[A-Z0-9]{16}\b'),
    }
    errors=[]
    for name in sorted(expected):
        if name.endswith('.png'):
            continue
        content=(ROOT/name).read_text()
        for kind, pattern in patterns.items():
            for match in pattern.finditer(content):
                errors.append(f'{name}:{content[:match.start()].count(chr(10))+1}: {kind} (value redacted)')
        if name.endswith(('.js', '.css', '.html', '.py')):
            assert 'SPDX-License-Identifier: MPL-2.0' in content, f'Missing license header: {name}'
    assert not errors, '\n'.join(errors)
    print(f'Release checks passed: {len(expected)} source files; {len(extension)} extension files.')
    return data


if __name__ == '__main__':
    try:
        check()
    except (AssertionError, ValueError, OSError) as exc:
        print(f'Release check failed: {exc}', file=sys.stderr)
        sys.exit(1)
