# Quiver-to-Obsidian Architecture Documentation

## Overview

This document describes the internal architecture and data flow for converting Quiver libraries to Obsidian format.

## High-Level Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      CLI Entry Point                             │
│                      (src/index.ts)                              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│              Quiver.newQuiver(libraryPath, extNames)             │
│                                                                  │
│  1. Loads library from filesystem                                │
│  2. Reads meta.json (hierarchy)                                  │
│  3. Reads all .qvnotebook directories                            │
│  4. Returns Quiver instance                                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│       quiver.transformQvLibraryToObsidian(outputPath)            │
│                                                                  │
│  Phase 1: Path Planning                                          │
│  ├─ Check output path validity                                   │
│  ├─ Walk meta hierarchy (notebooks in meta.json)                 │
│  │  ├─ Track notebooks in meta                                   │
│  │  ├─ Skip truly empty notebooks (no notes & no children)       │
│  │  ├─ Build full path with parents                              │
│  │  └─ Map note UUID → output path                               │
│  │                                                               │
│  └─ Process orphan notebooks (not in meta.json)                  │
│     ├─ Skip if no notes                                          │
│     └─ Map note UUID → output path (root level)                  │
│                                                                  │
│  Phase 2: Writing                                                │
│  └─ Call writeLibrary()                                          │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        writeLibrary()                            │
│                                                                  │
│  Re-walks hierarchy to build notebook list:                      │
│  ├─ Walk meta hierarchy again                                    │
│  │  ├─ Skip empty notebooks (no notes & no children)             │
│  │  └─ Add notebooks with notes to write list                    │
│  │                                                               │
│  └─ Add orphan notebooks with notes                              │
│                                                                  │
│  Write notebooks in parallel:                                    │
│  └─ Promise.all(notebooks.map(writeNotebook))                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      writeNotebook()                             │
│                                                                  │
│  For each notebook:                                              │
│  ├─ Create notebook directory                                    │
│  └─ Write all notes in parallel                                  │
│     └─ Promise.all(notes.map(writeNote))                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         writeNote()                              │
│                                                                  │
│  For each note:                                                  │
│  ├─ Call writeNoteToMarkdown()                                   │
│  │  ├─ Generate YAML frontmatter                                 │
│  │  ├─ Convert cells to markdown                                 │
│  │  │  ├─ MarkdownCell → direct output                           │
│  │  │  ├─ TextCell → HTML to markdown (Turndown)                 │
│  │  │  ├─ CodeCell → fenced code block                           │
│  │  │  ├─ LatexCell → fenced latex block                         │
│  │  │  └─ DiagramCell → fenced js block with comment             │
│  │  └─ Set file timestamps                                       │
│  │                                                               │
│  └─ Copy resource files to resources/                            │
│     └─ Apply filename transformations                            │
└─────────────────────────────────────────────────────────────────┘
```

## Data Structure Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    Quiver Library Structure                       │
└──────────────────────────────────────────────────────────────────┘

Library.qvlibrary/
├── meta.json                    ← QvLibraryMeta (hierarchy tree)
│   {
│     "uuid": "notebook-1-uuid",
│     "children": [
│       {
│         "uuid": "notebook-2-uuid",
│         "children": [...]
│       }
│     ]
│   }
├── Notebook1.qvnotebook/        ← Referenced in meta.json
│   ├── meta.json                ← QvNotebookMeta
│   ├── Note1.qvnote/            ← QvNote
│   │   ├── meta.json            ← QvNoteMeta
│   │   ├── content.json         ← QvNoteContent (cells)
│   │   └── resources/           ← QvNoteResource
│   │       └── image.png
│   └── Note2.qvnote/
├── Notebook2.qvnotebook/        ← Child of Notebook1
├── Inbox.qvnotebook/            ← NOT in meta.json (orphan)
└── .git/                        ← Ignored

                    ↓ TRANSFORMATION ↓

output/quiver/
├── Notebook1/
│   ├── Notebook2/
│   │   └── (notes from Notebook2)
│   └── (if Notebook1 has notes)
├── Inbox/
│   └── (notes from Inbox)
└── resources/
    └── (all resource files, deduplicated by name)
```

## Key Data Structures

```
QvLibrary
├── meta: QvLibraryMeta          (Tree structure of notebook hierarchy)
│   ├── uuid: string
│   └── children?: QvLibraryMeta[]
└── notebooks: QvNotebook[]      (Flat array of ALL notebooks)

Internal State During Export:
├── newNotePathRecord: Record<uuid, path>  (Maps note UUID to output file path)
├── notebooksInMeta: Set<uuid>             (Tracks which notebooks are in hierarchy)
└── outputQuiverPath: string               (Base output directory)
```

## Notebook Processing Logic

```
┌─────────────────────────────────────────────────────────────────┐
│               Notebook Decision Tree                             │
└─────────────────────────────────────────────────────────────────┘

For each notebook:
                                │
                                ▼
                   ┌────────────────────────┐
                   │ In meta.json?          │
                   └────────┬───────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
             YES                         NO
              │                           │
              ▼                           ▼
    ┌──────────────────┐        ┌──────────────────┐
    │ Has notes?       │        │ Has notes?       │
    └────┬─────────────┘        └────┬─────────────┘
         │                            │
    ┌────┴────┐                  ┌────┴────┐
   YES       NO                  YES       NO
    │         │                   │         │
    │         ▼                   │         ▼
    │    ┌──────────┐             │    ┌─────────┐
    │    │Has       │             │    │ SKIP    │
    │    │children? │             │    └─────────┘
    │    └────┬─────┘             │
    │         │                   │
    │    ┌────┴────┐              │
    │   YES       NO              │
    │    │         │              │
    │    │         ▼              │
    │    │    ┌─────────┐         │
    │    │    │ SKIP    │         │
    │    │    └─────────┘         │
    │    │                        │
    │    ▼                        │
    │  ┌──────────────────┐       │
    │  │ EXPORT           │       │
    │  │ (directory only) │       │
    │  └──────────────────┘       │
    │                             │
    ▼                             ▼
┌──────────────────┐      ┌──────────────────┐
│ EXPORT           │      │ EXPORT           │
│ (with notes)     │      │ (at root level)  │
└──────────────────┘      └──────────────────┘
```

## Critical Code Paths

### Path 1: Note Path Mapping (Phase 1)

```
transformQvLibraryToObsidian()
├── walkThroughNotebookHierarchty()
│   └── For each notebook in hierarchy:
│       ├── Check: hasNotes && hasChildren
│       ├── Build: [output, parent1, parent2, ..., notebook]
│       └── For each note: newNotePathRecord[uuid] = fullPath
│
└── For each orphan notebook:
    ├── Check: has notes
    ├── Build: [output, notebook]
    └── For each note: newNotePathRecord[uuid] = fullPath
```

### Path 2: Actual Writing (Phase 2)

```
writeLibrary()
├── Re-walk hierarchy (builds notebookInfoList)
│   └── Only includes notebooks with notes
│
└── For each notebook in notebookInfoList:
    └── writeNotebook()
        └── For each note:
            └── writeNote()
                ├── writeNoteToMarkdown()
                │   ├── Generate frontmatter
                │   ├── Convert cells
                │   └── Set timestamps
                └── Copy resources
```

## Link Transformation

```
Quiver Links                    →    Obsidian Links
────────────────────────────────────────────────────────
quiver-image-url/file.png       →    resources/file.png
quiver-file-url/doc.pdf         →    resources/doc.pdf
quiver-note-url/{UUID}          →    [[NoteName.md]]
quiver:///notes/{UUID}          →    [[NoteName.md]]

Resource Name Transformations:
────────────────────────────────────────────────────────
file.png?param=value            →    file.png
file.awebp (if configured)      →    file.png
FILE_WITH_NO_EXT                →    FILE_WITH_NO_EXT.png
```

## Potential Issues and Analysis

### 🐛 Issue 1: Double Hierarchy Walk (PERFORMANCE)
**Location:** `transformQvLibraryToObsidian()` and `writeLibrary()`

**Problem:**
- The hierarchy is walked twice with identical logic
- First in `transformQvLibraryToObsidian()` to build path map
- Second in `writeLibrary()` to build notebook list
- Both use the same filtering logic (hasNotes && hasChildren)

**Impact:** Performance inefficiency, code duplication

**Severity:** 🟡 Medium

---

### 🐛 Issue 2: Missing Notebook Reference Crash
**Location:** `walkThroughNotebookHierarchty()` in index.ts

```typescript
const notebooks: Record<string, QvNotebook> = {};
this.library.notebooks.forEach((notebook) => {
  notebooks[notebook.meta.uuid] = notebook;
});

// Later:
callback(notebooks[notebookName], parentNotebooks);
```

**Problem:**
- If meta.json references a notebook UUID that doesn't exist in the filesystem
- `notebooks[notebookName]` will be `undefined`
- This gets passed to callback, causing undefined access errors

**Impact:** Runtime crash when meta.json is out of sync with filesystem

**Severity:** 🔴 High

---

### 🐛 Issue 3: Parent Notebook Undefined Access
**Location:** Same as Issue 2

```typescript
parentNames.forEach((name) => {
  parentNotebooks.push(notebooks[name]);
});
```

**Problem:**
- If a parent UUID in the hierarchy doesn't exist, `notebooks[name]` is `undefined`
- The undefined gets pushed to array and accessed later
- Causes crash when accessing `parentNotebook.meta.name`

**Impact:** Runtime crash with corrupted hierarchy

**Severity:** 🔴 High

---

### 🐛 Issue 4: Resource File Name Collisions
**Location:** `writeNote()` → resource copying

```typescript
const resourceDirPath = path.join(this.outputQuiverPath, 'resources');
// ...
const dstPath = path.join(resourceDirPath, fileName);
await fse.copyFile(srcPath, dstPath);
```

**Problem:**
- All resources from all notes go to single `resources/` directory
- If two notes have resources with same name, last one wins (overwrite)
- No collision detection or unique naming

**Impact:** Data loss - resource files can be silently overwritten

**Severity:** 🔴 High

---

### 🐛 Issue 5: Duplicate UUID Detection Only Within Notebook
**Location:** `transformQvLibraryToObsidian()`

```typescript
notebook.notes.forEach((note) => {
  if (this.newNotePathRecord[note.meta.uuid]) {
    throw new Error(`there has two notes with uuid...`);
  }
```

**Problem:**
- This correctly checks for duplicate UUIDs across the entire library
- However, error message says "there has two notes" (grammar)

**Impact:** Unclear error message

**Severity:** 🟡 Medium (just UX)

---

### 🐛 Issue 6: No Validation of Note Link Targets
**Location:** `transformQuiverResourceAndNoteLink()`

```typescript
const linkNotePath = this.newNotePathRecord[uuid];
if (!linkNotePath) {
  console.warn(`Warning: Note link references non-existent note with UUID ${uuid}`);
  return ` [[${uuid}]]`;
}
```

**Problem:**
- Warning goes to console but export continues
- Link is converted to `[[UUID]]` which won't work in Obsidian
- No way to track or report these broken links

**Impact:** Broken links in exported notes, hard to debug

**Severity:** 🟡 Medium

---

### 🐛 Issue 7: Empty Notebook Directory Creation
**Location:** `writeNotebook()`

```typescript
private async writeNotebook(notebook: QvNotebook, newNotebookPath: string): Promise<void> {
  prepareDirectory(newNotebookPath);
  await Promise.all(notebook.notes.map(async (note) => {
    // ...
  }));
}
```

**Problem:**
- `prepareDirectory()` is always called, even for notebooks with only children
- Creates empty directories for parent-only notebooks
- Contradicts the documented behavior

**Impact:** Empty directories in output

**Severity:** 🟢 Low

---

### 🐛 Issue 8: File Handle Not Awaited on Close
**Location:** `writeNoteToMarkdown()`

```typescript
} finally {
  if (fd) { fd.close(); }
}
```

**Problem:**
- `fd.close()` returns a Promise but not awaited
- File might not be fully closed before moving on
- Could cause issues with timestamp setting or file locking

**Impact:** Race condition, potential file corruption

**Severity:** 🟡 Medium

---

### 🐛 Issue 9: No Error Handling for Timestamp Setting
**Location:** `writeNoteToMarkdown()`

```typescript
try {
  await utimes(notePath, {...});
} catch (error) {
  // ignore
}
```

**Problem:**
- Silently ignores all errors when setting timestamps
- User has no feedback if timestamps fail to set
- On some filesystems (FAT32, some network drives), this might always fail

**Impact:** Timestamps not preserved without user knowledge

**Severity:** 🟢 Low

---

### 🐛 Issue 10: Circular Reference in Hierarchy
**Location:** `walkThroughNotebookHierarchty()` (both versions)

**Problem:**
- No protection against circular references in meta hierarchy
- If meta.json has: A → B → C → A, infinite recursion
- Will cause stack overflow

**Impact:** Crash with corrupted meta.json

**Severity:** 🟡 Medium

---

### 🐛 Issue 11: Race Condition with Spinner
**Location:** `writeNote()`

```typescript
if (this.spinner) {
  this.spinner.stop();
  this.spinner = undefined;
}
this.bar?.tick();
```

**Problem:**
- Multiple notes write in parallel (Promise.all)
- All notes check and stop the same spinner
- Race condition on first note completion

**Impact:** Spinner might flicker or show incorrectly

**Severity:** 🟢 Low

---

### 🐛 Issue 12: No Validation of Output Path Creation
**Location:** `checkOutputDirPath()`

**Problem:**
- Only checks if path exists and is valid
- Doesn't verify write permissions
- Doesn't check disk space
- Export might fail midway through

**Impact:** Partial export with no rollback

**Severity:** 🟡 Medium

---

### 🐛 Issue 13: Progress Bar Count Mismatch
**Location:** Between `transformQvLibraryToObsidian()` and `writeLibrary()`

**Problem:**
- `this.noteCount` set from `newNotePathRecord` (includes parent-only notebooks' paths?)
- But `writeLibrary()` might skip notebooks if logic differs
- Progress bar might not reach 100%

**Impact:** Progress bar inaccuracy

**Severity:** 🟢 Low

---

### ✅ Good Practices Found:

1. **Parallel Processing**: Uses `Promise.all()` for concurrent writes
2. **Path Sanitization**: Properly handles `/` in titles
3. **Duplicate Name Handling**: Appends numbers for conflicts
4. **System Directory Filtering**: Ignores `.git`, etc.
5. **Error Boundaries**: Try-catch blocks in critical paths

## Recommendations

### Priority 1 (Critical - Fix Immediately):
1. **Add null checks** for notebook/parent lookups in `walkThroughNotebookHierarchty()`
2. **Implement resource file collision handling** with unique naming or subdirectories
3. **Await file handle close** to prevent race conditions

### Priority 2 (Important - Fix Soon):
1. **Consolidate hierarchy walking** - walk once, build both maps
2. **Add circular reference detection** in hierarchy traversal
3. **Validate write permissions** before starting export
4. **Better broken link reporting** - collect and report at end

### Priority 3 (Nice to Have):
1. Fix grammar in error messages
2. Add option to preserve/report failed timestamp settings
3. Clean up empty directory creation logic
4. Better progress bar synchronization

Would you like me to create bug fix implementations for any of these issues?
