"""Explicit repository binding for centrally managed product tasks.

The control checkout owns task artifacts. The execution checkout owns all
product commits, ranges and checks. Existing tasks without a binding retain
single-repository semantics. Never infer execution from a default package.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .config import _is_true_config_value
from .git import run_git
from .worktree import add_worktree, task_branch, worktree_root


class ExecutionError(RuntimeError):
    pass


def git(root: Path, *args: str) -> str:
    rc, out, err = run_git(list(args), cwd=root)
    if rc:
        raise ExecutionError(err.strip() or f"git failed in {root}")
    return out.strip()


def identity(root: Path) -> str:
    return str(Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve())


def package_root(main: Path, config: dict, package: str) -> tuple[Path, dict]:
    entry = (config.get('packages') or {}).get(package)
    if not isinstance(entry, dict) or not _is_true_config_value(entry.get('git')):
        raise ExecutionError(f'{package!r} is not a configured git: true package')
    raw = Path(entry.get('path') or '')
    root = (main / raw).resolve()
    if raw.is_absolute() or '..' in raw.parts or root == main.resolve() or not root.is_relative_to(main.resolve()):
        raise ExecutionError('product path must be contained in the control checkout')
    if Path(git(root, 'rev-parse', '--show-toplevel')).resolve() != root or identity(root) == identity(main):
        raise ExecutionError('package must be the root of an independent Git repository')
    return root, entry


def policy_hash(entry: dict) -> str:
    return hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()


def prepare(main: Path, task_dir: Path, data: dict, config: dict, mode: str | None,
            base_ref: str | None, merge_target: str | None) -> dict | None:
    mode = mode or data.get('execution_mode')
    if mode not in (None, 'control', 'package'):
        raise ExecutionError('invalid execution_mode; expected control or package')
    entry = (config.get('packages') or {}).get(str(data.get('package') or '')) or {}
    independent = isinstance(entry, dict) and _is_true_config_value(entry.get('git'))
    if mode is None and independent:
        raise ExecutionError('git: true package requires explicit --execution package --base-ref <ref> '
                             '--merge-target <branch>, or --execution control for a control-only task')
    if mode != 'package':
        return None
    if not base_ref or not merge_target or base_ref.startswith('-') or merge_target.startswith('-'):
        raise ExecutionError('package execution requires --base-ref and --merge-target')
    root, entry = package_root(main, config, str(data.get('package') or ''))
    sha = git(root, 'rev-parse', '--verify', f'{base_ref}^{{commit}}')
    git(root, 'check-ref-format', '--branch', merge_target)
    git(root, 'rev-parse', '--verify', f'refs/heads/{merge_target}')
    branch = task_branch(task_dir.name)
    effective = entry.get('execution') or {}
    path = worktree_root(root, effective) / task_dir.name
    if path.exists():
        raise ExecutionError(f'product worktree already exists: {path}')
    rc, _, _ = run_git(['show-ref', '--verify', '--quiet', f'refs/heads/{branch}'], cwd=root)
    if rc == 0:
        raise ExecutionError(f'product branch already exists: {branch}')
    return {'version': 1, 'package': data['package'], 'repo': str(root), 'repo_id': identity(root),
            'base_ref': base_ref, 'base': sha, 'base_branch': merge_target,
            'branch': branch, 'worktree_path': str(path), 'policy_hash': policy_hash(entry),
            'config': effective}


def create(binding: dict) -> None:
    add_worktree(Path(binding['repo']), Path(binding['worktree_path']), binding['branch'], binding['base'])


def validate(main: Path, config: dict, data: dict) -> dict | None:
    binding = data.get('execution_binding')
    if binding is None:
        return None
    if not isinstance(binding, dict) or binding.get('version') != 1:
        raise ExecutionError('unsupported execution binding')
    required = {'package', 'repo', 'repo_id', 'base', 'base_ref', 'base_branch', 'branch', 'worktree_path', 'policy_hash', 'config', 'control'}
    if not required.issubset(binding) or not isinstance(binding['control'], dict):
        raise ExecutionError('incomplete execution binding')
    if not {'base', 'base_branch', 'branch', 'worktree_path'}.issubset(binding['control']):
        raise ExecutionError('incomplete control binding')
    root, entry = package_root(main, config, binding['package'])
    if str(root) != binding['repo'] or identity(root) != binding['repo_id'] or policy_hash(entry) != binding['policy_hash']:
        raise ExecutionError('product repository or execution policy changed since start')
    if binding['config'] != (entry.get('execution') or {}):
        raise ExecutionError('frozen execution policy was modified')
    wt = Path(binding['worktree_path'])
    registered = git(root, 'worktree', 'list', '--porcelain').splitlines()
    if f'worktree {wt}' not in registered or identity(wt) != binding['repo_id']:
        raise ExecutionError('product worktree is not registered in the bound repository')
    if git(wt, 'symbolic-ref', '--short', 'HEAD') != binding['branch']:
        raise ExecutionError('product worktree branch changed')
    git(wt, 'merge-base', '--is-ancestor', binding['base'], 'HEAD')
    for key in ('worktree_path', 'branch', 'base', 'base_branch'):
        if data.get(key) != binding[key]:
            raise ExecutionError(f'execution binding disagrees with task field {key}')
    control = binding['control']
    cwt = Path(control['worktree_path'])
    if identity(cwt) != identity(main) or f'worktree {cwt}' not in git(main, 'worktree', 'list', '--porcelain').splitlines():
        raise ExecutionError('control worktree is not registered')
    if git(cwt, 'symbolic-ref', '--short', 'HEAD') != control['branch']:
        raise ExecutionError('control worktree branch changed')
    return binding


def control_data(data: dict) -> dict:
    binding = data.get('execution_binding')
    return {**data, **binding['control']} if binding else data


def fingerprint(root: Path, exclude: set[str] | None = None) -> dict:
    """Content as well as dirty paths: detect edits to already dirty files."""
    exclude = exclude or set()
    raw = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    files = {}
    for name in raw.split('\0'):
        if not name or name in exclude or '/.runtime/' in name or name.endswith('/.lock'):
            continue
        p = root / name
        if p.is_symlink():
            files[name] = 'link:' + str(p.readlink())
        elif p.is_file():
            files[name] = hashlib.sha256(p.read_bytes()).hexdigest()
        else:
            files[name] = 'missing'
    return {'head': git(root, 'rev-parse', 'HEAD'),
            'refs': git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'), 'files': files,
            'index': git(root, 'diff', '--cached', '--binary')}


def snapshot_control(main: Path, control: Path, task_rel: str, product: Path | None = None) -> dict:
    excluded = {f'{task_rel}/.lock'}
    snapshot = {'main': fingerprint(main, excluded), 'control': fingerprint(control, excluded)}
    if product is not None:
        product_state = fingerprint(product)
        # Product branch commits change refs, but must never change the user's main checkout.
        product_state.pop('refs')
        snapshot['product_main'] = product_state
    return snapshot


def check_control(main: Path, control: Path, task_rel: str, before: dict, product: Path | None = None) -> None:
    if snapshot_control(main, control, task_rel, product) != before:
        raise ExecutionError('protected control/product main repository changed during product delegation; evidence preserved')
