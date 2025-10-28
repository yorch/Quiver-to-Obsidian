#!/usr/bin/env node

/**
 * Quiver-to-Obsidian CLI
 * Command-line tool to convert Quiver libraries to Obsidian format.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Quiver from './quiver/index.js';
import * as fs from 'fs';

const program = new Command();
const { log } = console;
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)).toString()).version

program.requiredOption('-q, --quiver-path <path>', 'quiver library dir path')
  .requiredOption('-o, --output-path <path>', 'output dir path')
  .option('-e, --ext-names [ext...]', '[option] replace some unknown resource image file ext to `png`');
program.showHelpAfterError();
program.version(version, '-v, --version')

program.parse(process.argv);
const options = program.opts();
const { quiverPath } = options;
const { outputPath } = options;
const { extNames } = options;

/**
 * Main execution function for the CLI.
 * Converts a Quiver library to Obsidian format based on command-line options.
 */
const execute = async (): Promise<void> => {
  try {
    const quiver = await Quiver.newQuiver(quiverPath, extNames);
    const quiverOutput = await quiver.transformQvLibraryToObsidian(outputPath);
    log(chalk.green(`🎉 Finished, please check output path: ${quiverOutput}`));
    process.exit(0);
  } catch (error) {
    log(chalk.red(`Error: ${(error as Error).message}`));
    process.exit(1);
  }
};

execute();
