import fse from 'fs-extra';
import * as path from 'path';
import ProgressBar from 'progress';
import ora, {Ora} from 'ora';
import TurndownService from 'turndown';
import { utimes } from 'utimes';
import {
  CellType,
  QvLibrary, QvNote, QvNotebook,
} from './type.js';
import { readLibrary, walkThroughNotebookHierarchty, readNoteContent } from './quiver_parse.js';
import { checkOutputDirPath, prepareDirectory, newDistinctNoteName } from './utils.js';

/**
 * Main class for converting Quiver libraries to Obsidian format.
 * Handles reading Quiver notebooks, transforming content, and exporting to markdown.
 */
class Quiver {
  /** The loaded Quiver library data */
  private library: QvLibrary;

  /** Maps note UUIDs to their new file paths in the output */
  private newNotePathRecord: Record<string, string> = {};

  /** Output path for the converted Obsidian vault */
  private outputQuiverPath: string = '';

  /** Total number of notes to be processed */
  private noteCount = 0;

  /** Optional list of file extensions to replace with .png */
  private needReplaceExtNames?: string[];

  /** Progress bar for tracking export progress */
  private bar?: ProgressBar;

  /** Spinner for showing loading state */
  private spinner?: Ora

  /** Maps original resource filename to final filename (per note, for link updates) */
  private currentNoteResourceMap: Map<string, string> = new Map();

  /** Tracks broken note links found during export */
  private brokenLinks: Array<{ sourceNoteTitle: string, sourceNoteId: string, targetNoteId: string }> = [];

  /**
   * Private constructor. Use newQuiver() static method to create instances.
   *
   * @param library - The loaded Quiver library data
   * @param extNames - Optional list of file extensions to replace with .png
   */
  private constructor(library: QvLibrary, extNames: string[] | undefined) {
    this.library = library;
    if (extNames && extNames.length > 0) {
      this.needReplaceExtNames = extNames;
    }
  }

  /**
   * Normalize notebook path by splitting on / and trimming each component.
   *
   * @param pathName - The path to normalize
   * @returns Normalized path with trimmed components
   */
  private normalizePath(pathName: string): string {
    return pathName.split('/').map(part => part.trim()).join('/');
  }

  /**
   * Sanitize note title to be used as filename (replace / with - and trim).
   *
   * @param title - The note title to sanitize
   * @returns Sanitized filename-safe title
   */
  private sanitizeNoteTitle(title: string): string {
    return title.trim().replace(/\//g, '-');
  }

  /**
   * Check if a notebook UUID has children in the meta hierarchy.
   * This is used to determine if a notebook without notes should still be exported
   * as a parent directory to preserve the hierarchy structure.
   *
   * @param uuid - The UUID of the notebook to check
   * @returns true if the notebook has children, false otherwise
   */
  private notebookHasChildren(uuid: string): boolean {
    const findInMeta = (meta: any): boolean | null => {
      if (meta.uuid === uuid) {
        return meta.children && meta.children.length > 0;
      }
      if (meta.children && meta.children.length > 0) {
        for (const child of meta.children) {
          const result = findInMeta(child);
          if (result !== null) {
            return result;
          }
        }
      }
      return null;
    };

    const result = findInMeta(this.library.meta);
    return result === true;
  }

  /**
   * Factory method to create a new Quiver instance.
   * Loads the library from the specified path.
   *
   * @param libraryPath - Path to the Quiver library (.qvlibrary directory)
   * @param extNames - Optional list of file extensions to replace with .png
   * @returns A new Quiver instance with the loaded library
   */
  static async newQuiver(libraryPath: string, extNames?: string[]): Promise<Quiver> {
    const spinner = ora('Loading library...').start();
    const library = await readLibrary(libraryPath);
    const quiver = new Quiver(library, extNames);
    spinner.stop();
    return quiver;
  }

  /**
   * Transform the Quiver library to Obsidian format.
   * This is the main entry point for the conversion process.
   *
   * @param outputPath - Directory where the Obsidian vault will be created
   * @returns Path to the created Obsidian vault
   */
  async transformQvLibraryToObsidian(outputPath: string): Promise<string> {
    checkOutputDirPath(outputPath);

    // add `quiver` to output path
    this.outputQuiverPath = path.join(outputPath, 'quiver');

    this.spinner = ora('Reading library...').start();

    // Track which notebooks are in the meta hierarchy
    const notebooksInMeta = new Set<string>();
    this.walkThroughNotebookHierarchty((notebook, parents) => {
      notebooksInMeta.add(notebook.meta.uuid);

      // Skip truly empty notebooks (no notes and no children).
      // Notebooks with children but no notes are kept to preserve the hierarchy structure.
      // For example, a "Projects" notebook with no notes but containing "Work" and "Personal"
      // child notebooks will be exported as a parent directory.
      const hasNotes = notebook.notes && notebook.notes.length > 0;
      const hasChildren = this.notebookHasChildren(notebook.meta.uuid);
      if (!hasNotes && !hasChildren) {
        return;
      }

      const newPathList = [this.outputQuiverPath];
      parents.forEach((parentNotebook) => {
        newPathList.push(this.normalizePath(parentNotebook.meta.name));
      });
      newPathList.push(this.normalizePath(notebook.meta.name));
      const newPath = path.join(...newPathList);

      // Prevent file name conflicts (only if notebook has notes)
      const noteNames: string[] = [];
      if (hasNotes) {
        notebook.notes.forEach((note) => {
        if (this.newNotePathRecord[note.meta.uuid]) {
          throw new Error(`there has two notes with uuid(${note.meta.uuid}), please check and try again`);
        }
        let noteName = this.sanitizeNoteTitle(note.meta.title);
        if (noteNames.indexOf(noteName) > -1) {
          noteName = newDistinctNoteName(noteName, noteNames, 2);
        }
        noteNames.push(noteName);
        this.newNotePathRecord[note.meta.uuid] = path.join(newPath, `${noteName}.md`);
        });
      }
    });

    // Process notebooks not in meta (e.g., Inbox, Trash).
    // These notebooks are not part of the hierarchy, so they can't have children.
    // Only export them if they contain notes.
    this.library.notebooks.forEach((notebook) => {
      if (!notebooksInMeta.has(notebook.meta.uuid)) {
        // Skip empty notebooks (no notes)
        if (!notebook.notes || notebook.notes.length === 0) {
          return;
        }

        const newPath = path.join(this.outputQuiverPath, this.normalizePath(notebook.meta.name));

        // Prevent file name conflicts
        const noteNames: string[] = [];
        notebook.notes.forEach((note) => {
          if (this.newNotePathRecord[note.meta.uuid]) {
            throw new Error(`there has two notes with uuid(${note.meta.uuid}), please check and try again`);
          }
          let noteName = this.sanitizeNoteTitle(note.meta.title);
          if (noteNames.indexOf(noteName) > -1) {
            noteName = newDistinctNoteName(noteName, noteNames, 2);
          }
          noteNames.push(noteName);
          this.newNotePathRecord[note.meta.uuid] = path.join(newPath, `${noteName}.md`);
        });
      }
    });

    this.noteCount = Object.keys(this.newNotePathRecord).length;
    this.bar = new ProgressBar('Processing [:bar] :current/:total', { total: this.noteCount });
    await this.writeLibrary();

    // Report any broken links found during export
    this.reportBrokenLinks();

    return this.outputQuiverPath;
  }

  /**
   * Walk through the notebook hierarchy and invoke callback for each notebook.
   * Traverses the meta hierarchy depth-first, providing parent context.
   *
   * @param callback - Function called for each notebook with the notebook and its parents
   */
  private walkThroughNotebookHierarchty(callback: (notebook: QvNotebook, parents: QvNotebook[]) => void): void {
    const notebooks: Record<string, QvNotebook> = {};
    this.library.notebooks.forEach((notebook) => {
      notebooks[notebook.meta.uuid] = notebook;
    });

    const parents: string[] = [];
    this.library.meta.children?.forEach((meta) => {
      walkThroughNotebookHierarchty(meta, parents, (notebookName, parentNames) => {
        // Validate notebook exists
        const notebook = notebooks[notebookName];
        if (!notebook) {
          console.warn(`Warning: Notebook ${notebookName} referenced in meta.json but not found in filesystem. Skipping.`);
          return;
        }

        // Validate all parents exist
        const parentNotebooks: QvNotebook[] = [];
        for (const name of parentNames) {
          const parent = notebooks[name];
          if (!parent) {
            console.warn(`Warning: Parent notebook ${name} not found in filesystem. Skipping notebook ${notebookName}.`);
            return;
          }
          parentNotebooks.push(parent);
        }

        callback(notebook, parentNotebooks);
      });
    });
  }

  /**
   * Write all notebooks and their notes to the output directory.
   * Processes both hierarchical notebooks and standalone ones (Inbox, Trash).
   */
  private async writeLibrary(): Promise<void> {
    const notebookInfoList: Array<{ notebook: QvNotebook, notebookPath: string }> = [];

    // Track which notebooks are in the meta hierarchy
    const notebooksInMeta = new Set<string>();
    this.walkThroughNotebookHierarchty((notebook, parents) => {
      notebooksInMeta.add(notebook.meta.uuid);

      // Skip empty notebooks (no notes and no children)
      const hasNotes = notebook.notes && notebook.notes.length > 0;
      const hasChildren = this.notebookHasChildren(notebook.meta.uuid);
      if (!hasNotes && !hasChildren) {
        return;
      }

      const newPathList = [this.outputQuiverPath];
      parents.forEach((parentNotebook) => {
        newPathList.push(this.normalizePath(parentNotebook.meta.name));
      });
      newPathList.push(this.normalizePath(notebook.meta.name));
      const newNotebookPath = path.join(...newPathList);

      // Only add to list if it has notes (parent directories will be created automatically)
      if (hasNotes) {
        notebookInfoList.push({ notebook, notebookPath: newNotebookPath });
      }
    });

    // Add notebooks not in meta (e.g., Inbox, Trash)
    this.library.notebooks.forEach((notebook) => {
      if (!notebooksInMeta.has(notebook.meta.uuid)) {
        // Skip empty notebooks (no notes)
        if (!notebook.notes || notebook.notes.length === 0) {
          return;
        }

        const newNotebookPath = path.join(this.outputQuiverPath, this.normalizePath(notebook.meta.name));
        notebookInfoList.push({ notebook, notebookPath: newNotebookPath });
      }
    });

    await Promise.all(notebookInfoList.map(async (n) => {
      await this.writeNotebook(n.notebook, n.notebookPath);
    }));
  }

  /**
   * Write a single notebook with all its notes to the output directory.
   * Creates the notebook directory and processes all contained notes in parallel.
   *
   * @param notebook - The notebook to write
   * @param newNotebookPath - The output path for this notebook
   */
  private async writeNotebook(notebook: QvNotebook, newNotebookPath: string): Promise<void> {
    prepareDirectory(newNotebookPath);
    await Promise.all(notebook.notes.map(async (note) => {
      const notePath = this.newNotePathRecord[note.meta.uuid];
      await this.writeNote(note, notePath);
    }));
  }

  /**
   * Write a single note and its resources to the output directory.
   * Resources are stored in a _resources directory at the same level as the note.
   * Builds a mapping of original → final resource filenames for link updates.
   * Updates the progress bar after completion.
   *
   * @param note - The note to write
   * @param newNotePath - The output path for this note
   */
  private async writeNote(note: QvNote, newNotePath: string): Promise<void> {
    // Clear the resource map for this note
    this.currentNoteResourceMap.clear();

    // First pass: Copy resources to note-relative _resources directory
    if (note.resources) {
      // Resources go in _resources directory next to the note
      const noteDir = path.dirname(newNotePath);
      const resourceDirPath = path.join(noteDir, '_resources');
      prepareDirectory(resourceDirPath);

      // Process resources sequentially to build mapping before writing markdown
      for (const file of note.resources.files) {
        const srcPath = path.join(note.notePath, 'resources', file.name);
        const finalFileName = await this.copyResource(srcPath, file.name, resourceDirPath);

        // Store mapping: original name → final name
        this.currentNoteResourceMap.set(file.name, finalFileName);
      }
    }

    // Second pass: Write markdown with corrected resource links
    await this.writeNoteToMarkdown(note, newNotePath);

    if (this.spinner) {
      this.spinner.stop();
      this.spinner = undefined;
    }
    this.bar?.tick();
  }

  /**
   * Copy a resource file to the specified directory.
   * Applies name transformations (extension fixes, etc.) and handles name collisions
   * by appending numeric suffixes if needed.
   *
   * @param srcPath - Source path of the resource file
   * @param originalName - Original filename of the resource
   * @param resourceDirPath - Destination directory for the resource
   * @returns The final filename used in the resources directory
   */
  private async copyResource(srcPath: string, originalName: string, resourceDirPath: string): Promise<string> {
    // Apply name transformations (remove URL params, fix extensions, etc.)
    let fileName = this.replaceResourceName(originalName, true);
    let finalPath = path.join(resourceDirPath, fileName);

    // Handle name collision within this directory
    let counter = 1;
    while (await fse.pathExists(finalPath)) {
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      fileName = `${base}_${counter}${ext}`;
      finalPath = path.join(resourceDirPath, fileName);
      counter++;

      if (counter > 100) {
        throw new Error(`Too many resource name collisions for: ${originalName}`);
      }
    }

    // Copy the file
    await fse.copyFile(srcPath, finalPath);

    // Log if there was a collision
    if (counter > 1) {
      console.warn(`Resource name collision: ${originalName} → ${fileName}`);
    }

    return fileName;
  }

  /**
   * Generate YAML frontmatter from note metadata.
   * Includes title, UUID, creation/update dates, source, and tags.
   *
   * @param note - The note to generate frontmatter for
   * @returns YAML frontmatter string with --- delimiters
   */
  private generateFrontmatter(note: QvNote): string {
    const frontmatter: string[] = ['---'];

    // Add title
    const title = note.meta.title.replace(/"/g, '\\"');
    frontmatter.push(`title: "${title}"`);

    // Add UUID
    frontmatter.push(`uuid: ${note.meta.uuid}`);

    // Add source
    frontmatter.push(`source: Quiver`);

    // Add created date (convert Unix timestamp to ISO 8601)
    const createdDate = new Date(note.meta.created_at * 1000).toISOString();
    frontmatter.push(`created: ${createdDate}`);

    // Add updated date (convert Unix timestamp to ISO 8601)
    const updatedDate = new Date(note.meta.updated_at * 1000).toISOString();
    frontmatter.push(`updated: ${updatedDate}`);

    // Add tags if present
    if (note.meta.tags && note.meta.tags.length > 0) {
      frontmatter.push('tags:');
      note.meta.tags.forEach(tag => {
        frontmatter.push(`  - ${tag}`);
      });
    }

    frontmatter.push('---');
    return frontmatter.join('\n');
  }

  /**
   * Transform note content to markdown and write to file.
   * Converts all cell types (markdown, text, code, latex, diagram) to markdown format.
   * Also sets the file's creation and modification timestamps to match the note.
   *
   * @param note - The note to convert
   * @param notePath - The output path for the markdown file
   */
  private async writeNoteToMarkdown(note: QvNote, notePath: string): Promise<void> {
    let fd: fse.promises.FileHandle | undefined;
    try {
      await fse.createFile(notePath);
      fd = await fse.promises.open(notePath, 'w');

      // Write frontmatter first
      const frontmatter = this.generateFrontmatter(note);
      await fd.write(frontmatter);
      await fd.write('\n\n');

      const noteContent = await readNoteContent(note.contentPath);
      for (let i = 0; i < noteContent.cells.length; i++) {
        const cell = noteContent.cells[i];
        if (i !== 0) {
          await fd.write('\n\n');
        }
        const { data } = cell;
        switch (cell.type) {
          case CellType.MarkdownCell: {
            const transformData = this.transformQuiverResourceAndNoteLink(data, note);
            await fd.write(transformData);
            break;
          }
          case CellType.TextCell: {
            const turndownService = new TurndownService();
            const markdown = turndownService.turndown(data);
            const transformData = this.transformQuiverResourceAndNoteLink(markdown, note);
            await fd.write(transformData);
            break;
          }
          case CellType.CodeCell: {
            const language = cell.language ?? '';
            await fd.write(`\`\`\`${language}\n${data}\n\`\`\``);
            break;
          }
          case CellType.LatexCell: {
            await fd.write(`\`\`\`latex\n${data}\n\`\`\``);
            break;
          }
          case CellType.DiagramCell: {
            let tool = 'Sequence diagram, see https://bramp.github.io/js-sequence-diagrams';
            if (cell.diagramType === 'flow') {
              tool = 'Flowchart diagram, see http://flowchart.js.org';
            }
            await fd.write(`\`\`\`javascript\n// ${tool}\n${data}\`\`\``);
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      throw (error as Error);
    } finally {
      if (fd) {
        await fd.close();
      }
    }

    try {
      // rewrite create time and update time of md file
      await utimes(notePath, {
        btime: Number(note.meta.created_at * 1000),
        mtime: Number(note.meta.updated_at * 1000),
        atime: 0,
      });
    } catch (error) {
    // ignore
    }
  }

  /**
   * Transform Quiver resource and note link URLs to Obsidian format.
   * Converts quiver-image-url and quiver-file-url to _resources/ paths (relative to note).
   * Converts Quiver note links to Obsidian [[wikilinks]].
   * Tracks broken links for reporting.
   *
   * @param data - The markdown content to transform
   * @param note - The note being processed (for broken link tracking)
   * @returns Transformed content with Obsidian-compatible links
   */
  private transformQuiverResourceAndNoteLink(data: string, note: QvNote): string {
    // First, convert Quiver resource URLs to _resources/ format (note-relative)
    let transformData = data.replace(/quiver-image-url\//g, '_resources/');
    transformData = transformData.replace(/quiver-file-url\//g, '_resources/');

    // Apply resource name transformations (remove URL params, fix extensions, etc.)
    transformData = this.replaceResourceName(transformData, false);

    // Update resource links to use final filenames (after collision handling)
    // Match: _resources/filename.ext or _resources/filename (with optional URL params)
    transformData = transformData.replace(
      /_resources\/([^)\s?#]+?)(\.[a-zA-Z0-9]+)?(\)|\\|\s|\?|#|$)/g,
      (match, baseName, extension, suffix) => {
        const originalFileName = baseName + (extension || '');

        // Check if we have a mapping for this resource
        if (this.currentNoteResourceMap.has(originalFileName)) {
          const finalFileName = this.currentNoteResourceMap.get(originalFileName)!;
          return `_resources/${finalFileName}${suffix}`;
        }

        // Also check with .png added (for files without extensions)
        const withPng = originalFileName + '.png';
        if (this.currentNoteResourceMap.has(withPng)) {
          const finalFileName = this.currentNoteResourceMap.get(withPng)!;
          return `_resources/${finalFileName}${suffix}`;
        }

        // No mapping found, keep original
        return match;
      }
    );

    // Replace note links to Obsidian [[wikilinks]]
    // eslint-disable-next-line max-len
    transformData = transformData.replace(/\[.*?\]\((quiver-note-url|quiver:\/\/\/notes)\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\)/g, (_, __, uuid) => {
      const linkNotePath = this.newNotePathRecord[uuid];
      if (!linkNotePath) {
        // Track broken link with source note context
        this.brokenLinks.push({
          sourceNoteTitle: note.meta.title,
          sourceNoteId: note.meta.uuid,
          targetNoteId: uuid
        });
        // Keep UUID as link for user reference
        return ` [[${uuid}]]`;
      }
      const linkNoteName = path.basename(linkNotePath);
      return ` [[${linkNoteName}]]`;
    });
    return transformData;
  }

  /**
   * Rename resource file names and links for compatibility.
   * - Removes URL parameters from image links
   * - Replaces unknown extensions with .png (if configured)
   * - Adds .png extension to files without extensions
   *
   * @param data - The content or filename to process
   * @param isForFile - True if processing a filename, false if processing content
   * @returns Processed content or filename
   */
  private replaceResourceName(data: string, isForFile: boolean): string {
    const resourceTag = isForFile ? '' : '_resources/';
    const prefix = isForFile ? '^' : '\\(';
    const suffix = isForFile ? '$' : '\\)';
    // 1.remove url args from img file name, like:
    // `![](_resources/47D5523597D28227C87950448B4780A5.jpg =344x387)`
    // `9FFEF50881EA1326EA55C1BC43EC9314.png&w=2048&q=75`
    // `55F20500B6E0C67E3EA78ED6C149B4D9.svg?style=social&label=Follow%20on%20Twitter`
    // eslint-disable-next-line max-len
    const clearSuffixReg = new RegExp(`${prefix}(${resourceTag}.*?\\.(bmp|jpg|png|tif|gif|pcx|tga|exif|fpx|svg|psd|cdr|pcd|dxf|ufo|eps|ai|raw|WMF|webp|jpeg|ico|awebp))(\\s|&|\\?).*${suffix}`, 'gi');
    let transformData = data.replace(clearSuffixReg, (_, group1) => (isForFile ? group1 : `(${group1})`));

    // replace unknown image file ext to `png`
    if (this.needReplaceExtNames && this.needReplaceExtNames.length > 0) {
      const replaceExt = this.needReplaceExtNames.join('|');
      // eslint-disable-next-line max-len
      const renameAwebpReg = new RegExp(`${prefix}(${resourceTag}.*?)\\.(${replaceExt})${suffix}`, 'gi');
      transformData = transformData.replace(renameAwebpReg, (_, group1) => (isForFile ? `${group1}.png` : `(${group1}.png)`));
    }

    // add default ext (png) for none ext resource file like`(_resources/BC8755B05A094564A25EA19E438B73B3)`
    // eslint-disable-next-line max-len
    const addDefaultExtReg = new RegExp(`${prefix}(${resourceTag}[0-9A-Z]{32})${suffix}`, 'g');
    transformData = transformData.replace(addDefaultExtReg, (_, group1) => (isForFile ? `${group1}.png` : `(${group1}.png)`));

    return transformData;
  }

  /**
   * Report broken note links found during export.
   * Prints a summary of all broken links with source and target information.
   */
  private reportBrokenLinks(): void {
    if (this.brokenLinks.length === 0) {
      return;
    }

    console.warn(`\n⚠️  Found ${this.brokenLinks.length} broken note link${this.brokenLinks.length > 1 ? 's' : ''}:`);
    this.brokenLinks.forEach((link, index) => {
      console.warn(`  ${index + 1}. In note "${link.sourceNoteTitle}" (${link.sourceNoteId})`);
      console.warn(`     → Links to non-existent note: ${link.targetNoteId}`);
    });
    console.warn('\nThese links have been converted to [[UUID]] format for manual review.\n');
  }
}

export default Quiver;
