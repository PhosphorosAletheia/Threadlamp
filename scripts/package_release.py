#!/usr/bin/env python3
# Copyright (c) 2026 Phosphoros Research and contributors.
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Build deterministic public ZIPs strictly from the reviewed file inventory."""
import hashlib
import json
import zipfile
from check_release import ROOT, check


def main():
    inventory = check()
    manifest = json.loads((ROOT/'manifest.json').read_text())
    version = manifest['version'] + '-beta.1'
    output = ROOT/'dist'
    assert not output.is_symlink(), 'Refusing a symlinked output directory'
    output.mkdir(exist_ok=True)
    sums=[]
    for group in ('extension', 'source'):
        name=f'threadlamp-{version}-{group}.zip'
        path=output/name
        assert not path.is_symlink(), 'Refusing a symlinked output file'
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for filename in inventory[group]:
                prefix='' if group == 'extension' else 'threadlamp/'
                info=zipfile.ZipInfo(prefix+filename, (2026, 11, 9, 0, 0, 0))
                info.compress_type=zipfile.ZIP_DEFLATED
                info.create_system=3
                info.external_attr=0o100644 << 16
                archive.writestr(info, (ROOT/filename).read_bytes())
        with zipfile.ZipFile(path) as archive:
            assert archive.testzip() is None
            for filename in inventory[group]:
                prefix='' if group == 'extension' else 'threadlamp/'
                assert archive.read(prefix+filename) == (ROOT/filename).read_bytes()
        sums.append(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+name)
        print(f'{name}: {path.stat().st_size} bytes; {len(inventory[group])} verified entries')
    checksum=output/'SHA256SUMS'
    assert not checksum.is_symlink(), 'Refusing a symlinked checksum file'
    checksum.write_text('\n'.join(sums)+'\n')


if __name__ == '__main__':
    main()
