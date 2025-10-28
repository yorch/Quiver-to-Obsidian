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
        const parentNotebooks: QvNotebook[] = [];
        parentNames.forEach((name) => {
          parentNotebooks.push(notebooks[name]);
        });
        callback(notebooks[notebookName], parentNotebooks);
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
   * Converts the note to markdown and copies any associated resource files.
   * Updates the progress bar after completion.
   *
   * @param note - The note to write
   * @param newNotePath - The output path for this note
   */
  private async writeNote(note: QvNote, newNotePath: string): Promise<void> {
    await this.writeNoteToMarkdown(note, newNotePath);
    if (note.resources) {
      const resourceDirPath = path.join(this.outputQuiverPath, 'resources');
      prepareDirectory(resourceDirPath);
      await Promise.all(note.resources.files.map(async (file) => {
        const fileName = this.replaceResourceName(file.name, true);
        const srcPath = path.join(note.notePath, 'resources', file.name);
        const dstPath = path.join(resourceDirPath, fileName);
        await fse.copyFile(srcPath, dstPath);
      }));
    }
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = undefined;
    }
    this.bar?.tick();
  }

  /**
   * Generate YAML frontmatter from note metadata.
   * Includes title, UUID, creation/update dates, and tags.
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
      fd = await fse.promises.open(notePath, 'w+');

      // Write frontmatter first
      const frontmatter = this.generateFrontmatter(note);
      fd?.write(frontmatter);
      fd?.write('\n\n');

      const noteContent = await readNoteContent(note.contentPath);
      noteContent.cells.forEach((cell, i) => {
        if (i !== 0) {
          fd?.write('\n\n');
        }
        const { data } = cell;
        switch (cell.type) {
          case CellType.MarkdownCell: {
            const transformData = this.transformQuiverResourceAndNoteLink(data);
            fd?.write(transformData);
            break;
          }
          case CellType.TextCell: {
            const turndownService = new TurndownService();
            const markdown = turndownService.turndown(data);
            const transformData = this.transformQuiverResourceAndNoteLink(markdown);
            fd?.write(transformData);
            break;
          }
          case CellType.CodeCell: {
            const language = cell.language ?? '';
            fd?.write(`\`\`\`${language}\n${data}\n\`\`\``);
            break;
          }
          case CellType.LatexCell: {
            fd?.write(`\`\`\`latex\n${data}\n\`\`\``);
            break;
          }
          case CellType.DiagramCell: {
            let tool = 'Sequence diagram, see https://bramp.github.io/js-sequence-diagrams';
            if (cell.diagramType === 'flow') {
              tool = 'Flowchart diagram, see http://flowchart.js.org';
            }
            fd?.write(`\`\`\`javascript\n// ${tool}\n${data}\`\`\``);
            break;
          }
          default:
            break;
        }
      });
    } catch (error) {
      throw (error as Error);
    } finally {
      if (fd) { fd.close(); }
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
   * Converts quiver-image-url and quiver-file-url to resources/ paths.
   * Converts Quiver note links to Obsidian [[wikilinks]].
   *
   * @param data - The markdown content to transform
   * @returns Transformed content with Obsidian-compatible links
   */
  private transformQuiverResourceAndNoteLink(data: string): string {
    let transformData = data.replace(/quiver-image-url\//g, 'resources/');
    transformData = transformData.replace(/quiver-file-url\//g, 'resources/');
    transformData = this.replaceResourceName(transformData, false);

    // replace note link in content to obsidian link
    // eslint-disable-next-line max-len
    transformData = transformData.replace(/\[.*?\]\((quiver-note-url|quiver:\/\/\/notes)\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\)/g, (_, __, uuid) => {
      const linkNotePath = this.newNotePathRecord[uuid];
      if (!linkNotePath) {
        // Note doesn't exist in library, keep original link or use UUID
        console.warn(`Warning: Note link references non-existent note with UUID ${uuid}`);
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
    const resourceTag = isForFile ? '' : 'resources/';
    const prefix = isForFile ? '^' : '\\(';
    const suffix = isForFile ? '$' : '\\)';
    // 1.remove url args from img file name, like:
    // `![](resources/47D5523597D28227C87950448B4780A5.jpg =344x387)`
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

    // add default ext (png) for none ext resource file like`(resources/BC8755B05A094564A25EA19E438B73B3)`
    // eslint-disable-next-line max-len
    const addDefaultExtReg = new RegExp(`${prefix}(${resourceTag}[0-9A-Z]{32})${suffix}`, 'g');
    transformData = transformData.replace(addDefaultExtReg, (_, group1) => (isForFile ? `${group1}.png` : `(${group1}.png)`));

    return transformData;
  }
}

export default Quiver;
