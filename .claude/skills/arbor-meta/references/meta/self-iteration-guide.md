# Arbor Self-Iteration Guide

How to maintain skill documentation when customizing Arbor.

---

## Core Principle

**Every Arbor modification MUST be documented in the appropriate skill.**

```
Modification to Arbor → Update arbor-local (project skill)
Update to Arbor itself → Update arbor-meta (meta skill)
```

---

## Decision Tree

```
Is this a modification to Arbor?
│
├── YES: What kind?
│   │
│   ├── Project-specific customization
│   │   └── Update .claude/skills/arbor-local/SKILL.md
│   │
│   ├── Bug fix to core Arbor
│   │   └── Update ~/.claude/skills/arbor-meta/
│   │       (or project copy if reviewing first)
│   │
│   └── New feature to core Arbor
│       └── Update arbor-meta after release
│
└── NO: Just using Arbor
    └── No skill update needed
```

---

## Self-Iteration Workflow

### Step 1: Before Making Changes

```bash
# Check if project skill exists
ls .claude/skills/arbor-local/SKILL.md

# If not, create it from template
mkdir -p .claude/skills/arbor-local
# Copy template from arbor-meta/references/arbor-local-template.md
```

### Step 2: Make the Arbor Modification

Do your work: add command, modify hook, etc.

### Step 3: Document in Project Skill

Open `.claude/skills/arbor-local/SKILL.md` and:

1. **Find the right section** (Commands/Agents/Hooks/Specs/Workflow)
2. **Add entry using template**
3. **Update changelog**
4. **Update summary counts**

### Step 4: Verify Documentation

Ask yourself:
- [ ] Would another AI understand what was changed?
- [ ] Is the "why" documented?
- [ ] Are affected files listed?
- [ ] Is the date recorded?

---

## Documentation Templates

### New Command

```markdown
#### /arbor:my-command
- **File**: `.claude/commands/arbor/my-command.md`
- **Purpose**: Brief description of what it does
- **Added**: 2026-01-31
- **Reason**: Why this command was needed

**Usage**:
```
/arbor:my-command [args]
```

**Example**:
User asks "..." → Command does "..."
```

### New Agent

```markdown
#### my-agent
- **File**: `.claude/agents/my-agent.md`
- **Purpose**: What this agent specializes in
- **Tools**: Read, Write, Edit, Bash, Glob, Grep
- **Model**: opus
- **Added**: 2026-01-31
- **Reason**: Why this agent was needed

**Hook Integration**:
- Added to `inject-subagent-context.py` at line X
- Uses `my-agent.jsonl` for context

**Invocation**:
```
Task(subagent_type="my-agent", prompt="...")
```
```

### Hook Modification

```markdown
#### inject-subagent-context.py
- **Hook Event**: PreToolUse:Task
- **Change**: Added handling for `my-agent` subagent type
- **Lines Modified**: 45-67, 120-135
- **Date**: 2026-01-31
- **Reason**: Support new agent type

**Code Changes**:

```python
# Added constant
AGENT_MY_AGENT = "my-agent"

# Added to agent list
AGENTS_ALL = (..., AGENT_MY_AGENT)

# Added context function
def get_my_agent_context(repo_root, task_dir):
    ...
```
```

### Spec Category Addition

```markdown
#### security/
- **Path**: `.arbor/spec/security/`
- **Purpose**: Security guidelines for the project
- **Files**:
  - `index.md` - Category overview
  - `auth-guidelines.md` - Authentication patterns
  - `input-validation.md` - Validation requirements
- **Added**: 2026-01-31
- **Reason**: Project requires security-focused development

**JSONL Integration**:
```jsonl
{"file": ".arbor/spec/security/index.md", "reason": "Security guidelines"}
```
```

### Workflow Change

```markdown
#### Custom Phase Order
- **What**: Changed default task phases to include research phase
- **Files Affected**:
  - `.arbor/scripts/task.py` (init-context function)
  - Default task.json template
- **Date**: 2026-01-31
- **Reason**: All tasks in this project need research first

**New Default next_action**:
```json
[
  {"phase": 1, "action": "research"},
  {"phase": 2, "action": "implement"},
  {"phase": 3, "action": "check"},
  {"phase": 4, "action": "finish"},
  {"phase": 5, "action": "create-pr"}
]
```
```

---

## Changelog Format

```markdown
### 2026-01-31 - Feature: Custom Research Phase
- Added research phase as default first phase
- Modified task.py init-context
- Updated task.json template
- Reason: Project complexity requires upfront research

### 2026-01-30 - Bugfix: Hook Timeout
- Increased ralph-loop.py timeout from 10s to 30s
- Reason: Complex verification commands were timing out

### 2026-01-29 - Initial Setup
- Initialized arbor-local skill
- Base Arbor version: 0.3.0
```

---

## Multi-Project Scenario

When working with multiple Arbor projects:

```
~/projects/
├── project-a/
│   └── .claude/skills/arbor-local/   # Project A customizations
├── project-b/
│   └── .claude/skills/arbor-local/   # Project B customizations
└── project-c/
    └── .claude/skills/arbor-local/   # Project C customizations

~/.claude/skills/
└── arbor-meta/                        # Shared meta-skill (vanilla Arbor)
```

**Each project has its own `arbor-local`** documenting that project's specific customizations.

**The meta-skill is shared** and documents vanilla Arbor.

---

## Upgrade Workflow

When upgrading Arbor to a new version:

### 1. Review New Version Changes

```bash
# Compare new meta-skill with current
diff -r ~/.claude/skills/arbor-meta/references/ \
        ./new-arbor-meta/references/
```

### 2. Check for Conflicts

Review each customization in `arbor-local`:
- Does new version include this feature natively?
- Does new version break this customization?
- Can this customization be simplified?

### 3. Merge Carefully

```bash
# Backup current meta-skill
cp -r ~/.claude/skills/arbor-meta ~/.claude/skills/arbor-meta.backup

# Update meta-skill
cp -r ./new-arbor-meta/* ~/.claude/skills/arbor-meta/
```

### 4. Update Project Skills

Add migration note to `arbor-local`:

```markdown
### 2026-02-01 - Upgraded to Arbor 0.4.0
- Updated meta-skill to 0.4.0
- Kept custom `security-agent` (not in vanilla)
- Migrated `my-command` to new command format
- Removed `old-hook` customization (now in vanilla)
```

---

## AI Instructions

When an AI modifies Arbor, it MUST:

1. **Check** if `arbor-local` exists in the project
2. **Create** it from template if missing
3. **Document** the change immediately after making it
4. **Update** the changelog with date and description
5. **Verify** the documentation is complete

**Never** modify `arbor-meta` for project-specific changes.

**Always** tell the user what was documented.

Example AI response:
> "I've added the `/arbor:deploy` command and documented it in `.claude/skills/arbor-local/SKILL.md` under the Commands section."
