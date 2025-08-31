import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';

const apiUrl = process.env.API_URL;
const model = process.env.MODEL;


// Add hardcoded input path here if you want
const inputPath = process.argv[2] || '';
const requiredFields = ["title", "stage", "category"];
const baseQueryPrefix = `Here is some data in raw text, Please convert it into JSON for me, discarding the unneded parts.
The output JSON should have the form:
{title: string, stage: string, category: string, startTime24hr: string, endTime24hr: string, }
the times should both be in the format HH:MM, in 24 hour format, with no seconds, day or date.
Maintain case sensitivity.
`;
const storage = {};
const failures = [];

async function doQuery(prompt) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      format: 'json',
      stream: false,
    }),
  });

  const resData = await response.json();
  let responseText = (resData && resData.response) ? resData.response.trim() : "";

  let openIdx = responseText.indexOf("{");
  let closeIdx = responseText.lastIndexOf("}");
  if (openIdx === -1 || closeIdx === -1 || openIdx >= closeIdx) {
    throw new Error("No valid JSON object detected");
  }
  let jsonString = responseText.slice(openIdx, closeIdx + 1);
  let parsed = JSON.parse(jsonString);

  const missingFields = requiredFields.filter(f => !parsed.hasOwnProperty(f));
  if (missingFields.length) {
    console.log('Missing fields:', missingFields);
    console.log(`Response: `, parsed);
    const err = new Error("Missing required field(s)");
    err.response = parsed;
    err.responseJsonText = responseText;
    throw err;
  }

  return parsed;
}

class QueryQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.idleResolvers = [];
    this.waitingNotifies = 0;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.runNext();
    });
  }

  async runNext() {
    if (this.running) return;
    if (this.queue.length === 0) {
      if (this.waitingNotifies === 0) {
        this._notifyIdle();
      }
      return;
    }

    this.running = true;
    const { task, resolve, reject } = this.queue.shift();

    try {
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running = false;
      this.runNext();
    }
  }

  _notifyIdle() {
    this.idleResolvers.forEach(resolve => resolve());
    this.idleResolvers = [];
  }

  finished() {missingFields:
    if (this.queue.length === 0 && this.running === false && this.waitingNotifies === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.idleResolvers.push(resolve);
    });
  }

  notifyWaiting(count = 1) {
    if (count <= 0) return; // ignore invalid counts
    this.waitingNotifies += count;
  }

  notifyArrived(count = 1) {
    if (count <= 0) return;
    this.waitingNotifies -= count;
    if (this.waitingNotifies < 0) this.waitingNotifies = 0;

    // If queue is empty and no rmissingFields:unning task and no more waiting notifications, resolve idle
    if (this.queue.length === 0 && this.running === false && this.waitingNotifies === 0) {
      this._notifyIdle();
    }
  }
}


async function processContent(content, defaultCategory, queue) {
  const defaultCategoryStr = defaultCategory ? ` And if no explicit category in the text, use ${defaultCategory}` : "";
  const queryPrefix = baseQueryPrefix + defaultCategoryStr;

  const sections = content.split(/(\r?\n){2,}/).map(s => s.trim()).filter(Boolean);
  if (defaultCategory)
    console.log(`${defaultCategory.slice(0,2)}: ${defaultCategory} has: `);
  console.log(`${sections.length} sections`);

  for (const [idx, section] of sections.entries()) {
      const prompt = `${queryPrefix}\n${section}`;
      try {
        const parsed = await queue.enqueue(() => doQuery(prompt));

        // Add fields that will be manualy filled in later
        parsed.start = 0;
        parsed.end = 0;

        console.log(`Enqueued query ${defaultCategory.slice(0,2)}${idx}`);
        if (!storage[parsed.stage]) storage[parsed.stage] = [];
        storage[parsed.stage].push(parsed);
      } catch (e) {
        failures.push({ query: section, error: String(e), response: e.response, responseJson: e.responseJson });
        console.log("Failure on section:\n", section, "\nError/Response:\n", (e.message || e), "\n");
      }
    }  
  queue.notifyArrived(1); 
}

async function main() {
  if (!inputPath) {
    console.error("Usage: node section_llm.js <file_or_dir>");
    process.exit(1);
  }

  const stat = await fs.stat(inputPath);
  const queue = new QueryQueue();

  if (stat.isFile()) {
    await fs.readFile(inputPath, { encoding: 'utf-8' })
      .then(content=> {
        console.log(`Read ${inputPath}. Content length is ${content.length}`);
        processContent(content, "", queue);
      });
  } else if (stat.isDirectory()) {
    const files = (await fs.readdir(inputPath, { withFileTypes: true }))
      .filter(dirent => dirent.isFile())
      .map(dirent => dirent.name);

    if (files.length === 0) {
      console.error("Directory contains no files");
      process.exit(1);
    }
    
    console.log(`Found ${files.length} files: ${files.map(fullPath=> path.parse(fullPath).name).join(', ')}.`);
    await Promise.all(files.map(async (filename) => {
      try {
        queue.notifyWaiting(1);
        fs.readFile(path.join(inputPath, filename), { encoding: 'utf-8' })
          .then(content=> {
            const category = path.parse(filename).name;
            console.log(`Read ${category}. Content length is ${content.length}`);
            processContent(content, category, queue);
          });
      } catch (err) {
        console.error(`Failed to process file ${filename}`, err);
      }
    }));
  } else {
    console.error("Input path is neither a file nor a directory");
    process.exit(1);
  }

  await queue.finished();
  await fs.writeFile('llm_results.json', JSON.stringify(storage, null, 2));
  await fs.writeFile('llm_failures.json', JSON.stringify(failures, null, 2));
  console.log(`Successes: ${Object.values(storage).flat().length}, Failures: ${failures.length}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
