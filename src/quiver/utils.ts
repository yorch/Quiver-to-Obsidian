import fse from 'fs-extra';
import * as path from 'path';

/**
 * Check if the output directory is valid and doesn't conflict with existing data.
 * Verifies that the output path is a directory and that ${outputPath}/quiver doesn't already exist.
 *
 * @param outputPath - The intended output directory path
 * @throws Error if output path is not a directory or if ${outputPath}/quiver already exists
 */
export const checkOutputDirPath = (outputPath: string): void => {
  let stat: fse.Stats;
  try {
    stat = fse.statSync(outputPath);
  } catch (error) {
    // not exists, we will create it later
    return;
  }
  if (stat.isDirectory()) {
    const outputQuiverPath = path.join(outputPath, 'quiver');
    try {
      stat = fse.statSync(outputQuiverPath);
    } catch (error) {
      // not exists, we will create it later
      return;
    }
    throw new Error(`${outputQuiverPath} is already exists`);
  }
  throw new Error('output path must be a directory!');
};

/**
 * Create a directory if it doesn't exist.
 * Creates all necessary parent directories as well.
 *
 * @param dirPath - The directory path to create
 */
export const prepareDirectory = (dirPath: string): void => {
  if (!fse.existsSync(dirPath)) {
    fse.mkdirpSync(dirPath);
  }
};

/** Maximum number of rename attempts before giving up */
const MAX_RENAME_COUNT = 100;

/**
 * Generate a distinct note name by appending a number to avoid conflicts.
 * Recursively tries incrementing numbers until a unique name is found.
 *
 * @param noteName - The original note name
 * @param currentNames - Array of names that already exist
 * @param index - The current number suffix to try (starts at 2 for "name 2")
 * @returns A unique name that doesn't conflict with existing names
 * @throws Error if MAX_RENAME_COUNT attempts are exceeded
 */
export function newDistinctNoteName(noteName: string, currentNames: string[], index: number): string {
  if (index > MAX_RENAME_COUNT) {
    throw new Error(`rename resource name failed: ${noteName}`);
  }
  const newName = `${noteName} ${index}`;
  if (currentNames.indexOf(newName) > -1) {
    return newDistinctNoteName(noteName, currentNames, index + 1);
  }
  return newName;
}
