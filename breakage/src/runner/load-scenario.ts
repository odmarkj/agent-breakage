import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import type { Scenario } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let validator: ValidateFunction<Scenario> | null = null;
let vocabCategories: Set<string> | null = null;

async function getValidator(): Promise<ValidateFunction<Scenario>> {
  if (validator) return validator;
  const schemaPath = resolve(__dirname, '../../schemas/scenario.schema.json');
  const schemaText = await readFile(schemaPath, 'utf8');
  const schema = JSON.parse(schemaText);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  validator = ajv.compile<Scenario>(schema);
  return validator;
}

async function getVocabCategories(): Promise<Set<string>> {
  if (vocabCategories) return vocabCategories;
  const vocabPath = resolve(__dirname, '../../vocab/root-cause-categories.yaml');
  const text = await readFile(vocabPath, 'utf8');
  const doc = parseYaml(text) as { categories: Array<{ id: string }> };
  vocabCategories = new Set(doc.categories.map((c) => c.id));
  return vocabCategories;
}

/**
 * Load and validate a scenario YAML. Throws with an explanatory
 * error if the file fails JSON-Schema validation, or if any
 * referenced category is not in the vocabulary.
 */
export async function loadScenario(path: string): Promise<Scenario> {
  const text = await readFile(path, 'utf8');
  const parsed = parseYaml(text) as unknown;

  const validate = await getValidator();
  if (!validate(parsed)) {
    const errs = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || '/'} ${e.message}`)
      .join('\n');
    throw new Error(`Scenario ${path} failed schema validation:\n${errs}`);
  }

  const scenario = parsed as Scenario;

  const vocab = await getVocabCategories();
  if (!vocab.has(scenario.ground_truth.primary_category)) {
    throw new Error(
      `Scenario ${scenario.id}: ground_truth.primary_category ` +
        `"${scenario.ground_truth.primary_category}" is not in the vocabulary. ` +
        `See breakage/vocab/root-cause-categories.yaml.`,
    );
  }
  for (const sec of scenario.ground_truth.secondary_categories) {
    if (!vocab.has(sec)) {
      throw new Error(
        `Scenario ${scenario.id}: secondary_category "${sec}" is not in the vocabulary.`,
      );
    }
  }

  return scenario;
}
