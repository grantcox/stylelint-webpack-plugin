const { dirname, isAbsolute, join } = require('path');

const StylelintError = require('./StylelintError');
const getStylelint = require('./getStylelint');
const { arrify } = require('./utils');

/** @typedef {import('webpack').Compiler} Compiler */
/** @typedef {import('webpack').Compilation} Compilation */
/** @typedef {import('./getStylelint').Stylelint} Stylelint */
/** @typedef {import('./getStylelint').LintResult} LintResult */
/** @typedef {import('./getStylelint').LinterResult} LinterResult */
/** @typedef {import('./getStylelint').Formatter} Formatter */
/** @typedef {import('./getStylelint').FormatterType} FormatterType */
/** @typedef {import('./options').Options} Options */
/** @typedef {(compilation: Compilation) => Promise<void>} GenerateReport */
/** @typedef {{errors?: StylelintError, warnings?: StylelintError, generateReportAsset?: GenerateReport}} Report */
/** @typedef {() => Promise<Report>} Reporter */
/** @typedef {(files: string|string[]) => void} Linter */
/** @typedef {{[files: string]: LintResult}} LintResultMap */

/** @type {WeakMap<Compiler, LintResultMap>} */
const resultStorage = new WeakMap();

/**
 * @param {string|undefined} key
 * @param {Options} options
 * @param {Compilation} compilation
 * @returns {{lint: Linter, report: Reporter, threads: number}}
 */
function linter(key, options, compilation) {
  /** @type {Stylelint} */
  let stylelint;

  /** @type {(files: string|string[]) => Promise<LintResult[]>} */
  let lintFiles;

  /** @type {() => Promise<void>} */
  let cleanup;

  /** @type number */
  let threads;

  /** @type {Promise<LintResult[]>[]} */
  const rawResults = [];

  const crossRunResultStorage = getResultStorage(compilation);

  try {
    ({ stylelint, lintFiles, cleanup, threads } = getStylelint(key, options));
  } catch (e) {
    throw new StylelintError(e.message);
  }

  return {
    lint,
    report,
    threads,
  };

  /**
   * @param {string | string[]} files
   */
  function lint(files) {
    for (const file of arrify(files)) {
      delete crossRunResultStorage[file];
    }
    rawResults.push(
      lintFiles(files).catch((e) => {
        // @ts-ignore
        compilation.errors.push(new StylelintError(e.message));
        return [];
      }),
    );
  }

  async function report() {
    // Filter out ignored files.
    let results = removeIgnoredWarnings(
      // Get the current results, resetting the rawResults to empty
      await flatten(rawResults.splice(0, rawResults.length)),
    );

    await cleanup();

    for (const result of results) {
      crossRunResultStorage[String(result.source)] = result;
    }

    results = Object.values(crossRunResultStorage);

    // do not analyze if there are no results or stylelint config
    if (!results || results.length < 1) {
      return {};
    }

    const formatter = await loadFormatter(stylelint, options.formatter);

    /** @type {LinterResult} */
    const returnValue = {
      // @ts-ignore
      cwd: options.cwd,
      errored: false,
      results: [],
      output: '',
      reportedDisables: [],
      ruleMetadata: getRuleMetadata(results),
    };

    const { errors, warnings } = formatResults(
      formatter,
      parseResults(options, results),
      returnValue,
    );

    return {
      errors,
      warnings,
      generateReportAsset,
    };

    /**
     * @param {Compilation} compilation
     * @returns {Promise<void>}
     */
    async function generateReportAsset({ compiler }) {
      const { outputReport } = options;
      /**
       * @param {string} name
       * @param {string | Buffer} content
       */
      const save = (name, content) =>
        /** @type {Promise<void>} */ (
          new Promise((finish, bail) => {
            if (!compiler.outputFileSystem) return;
            const { mkdir, writeFile } = compiler.outputFileSystem;
            // ensure directory exists
            // @ts-ignore - the types for `outputFileSystem` are missing the 3 arg overload
            mkdir(dirname(name), { recursive: true }, (err) => {
              /* istanbul ignore if */
              if (err) bail(err);
              else
                writeFile(name, content, (err2) => {
                  /* istanbul ignore if */
                  if (err2) bail(err2);
                  else finish();
                });
            });
          })
        );

      if (!outputReport || !outputReport.filePath) {
        return;
      }

      const content = outputReport.formatter;
      (await loadFormatter(stylelint, outputReport.formatter))(
        results,
        returnValue,
      );
      formatter(results, returnValue);

      let { filePath } = outputReport;
      if (!isAbsolute(filePath)) {
        filePath = join(compiler.outputPath, filePath);
      }

      await save(filePath, String(content));
    }
  }
}

/**
 * @param {Formatter} formatter
 * @param {{ errors: LintResult[]; warnings: LintResult[]; }} results
 * @param {LinterResult} returnValue
 * @returns {{errors?: StylelintError, warnings?: StylelintError}}
 */
function formatResults(formatter, results, returnValue) {
  let errors;
  let warnings;
  if (results.warnings.length > 0) {
    warnings = new StylelintError(formatter(results.warnings, returnValue));
  }

  if (results.errors.length > 0) {
    errors = new StylelintError(formatter(results.errors, returnValue));
  }

  return {
    errors,
    warnings,
  };
}

/**
 * @param {Options} options
 * @param {LintResult[]} results
 * @returns {{errors: LintResult[], warnings: LintResult[]}}
 */
function parseResults(options, results) {
  /** @type {LintResult[]} */
  const errors = [];

  /** @type {LintResult[]} */
  const warnings = [];

  results.forEach((file) => {
    const fileErrors = file.warnings.filter(
      (message) => options.emitError && message.severity === 'error',
    );

    if (fileErrors.length > 0) {
      errors.push({
        ...file,
        warnings: fileErrors,
      });
    }

    const fileWarnings = file.warnings.filter(
      (message) => options.emitWarning && message.severity === 'warning',
    );

    if (fileWarnings.length > 0) {
      warnings.push({
        ...file,
        warnings: fileWarnings,
      });
    }
  });

  return {
    errors,
    warnings,
  };
}

/**
 * @param {Stylelint} stylelint
 * @param {FormatterType=} formatter
 * @returns {Promise<Formatter>|Formatter}
 */
function loadFormatter(stylelint, formatter) {
  if (typeof formatter === 'function') {
    return formatter;
  }

  if (typeof formatter === 'string') {
    try {
      return stylelint.formatters[formatter];
    } catch (_) {
      // Load the default formatter.
    }
  }

  return stylelint.formatters.string;
}

/**
 * @param {LintResult[]} results
 * @returns {LintResult[]}
 */
function removeIgnoredWarnings(results) {
  return results.filter((result) => !result.ignored);
}

/**
 * @param {Promise<LintResult[]>[]} results
 * @returns {Promise<LintResult[]>}
 */
async function flatten(results) {
  /**
   * @param {LintResult[]} acc
   * @param {LintResult[]} list
   */
  const flat = (acc, list) => [...acc, ...list];
  return (await Promise.all(results)).reduce(flat, []);
}

/**
 * @param {Compilation} compilation
 * @returns {LintResultMap}
 */
function getResultStorage({ compiler }) {
  let storage = resultStorage.get(compiler);
  if (!storage) {
    resultStorage.set(compiler, (storage = {}));
  }
  return storage;
}

/**
 * @param {LintResult[]} lintResults
 */
/* istanbul ignore next */
function getRuleMetadata(lintResults) {
  const [lintResult] = lintResults;

  // eslint-disable-next-line no-undefined
  if (lintResult === undefined) return {};

  // eslint-disable-next-line no-underscore-dangle, no-undefined
  if (lintResult._postcssResult === undefined) return {};

  // eslint-disable-next-line no-underscore-dangle
  return lintResult._postcssResult.stylelint.ruleMetadata;
}

module.exports = linter;
