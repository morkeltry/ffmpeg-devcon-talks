import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import https from 'https';
import fetch from 'node-fetch';   // needed for agent.rejectUnauthorized to work as expected
import { URL } from 'url';
import 'dotenv/config';

const apiUrl = process.env.API_URL;
const API_KEY = process.env.API_KEY; 
const model = process.env.MODEL;
const urlObj = new URL(apiUrl);
urlObj.protocol = (urlObj.port === '11434') ? 'http:' : 'https:';
const logging = false;

// Add hardcoded input path here if you want
const inputPath = process.argv[2] || '';
// const requiredFields = ["title", "stage", "category"];
const requiredFields = ["title", "stage"];
const baseQueryPrefix = `Here is some data in raw text, Please convert it into JSON for me, discarding the unneeded parts.
The point of me asking you to do this is to remove the cruft. So don't just give me the cruft and think that that's fine.
You should only return vaid JSON in the form requested.  No explanation or chat - your responses will be processed in batch by a program, so you chatting or explaining will not help, it will only break things.
The output JSON should be valid JSON of the form:
{title: string, stage: string, startTime24hr: string, endTime24hr: string, }
The title will be on its own in a single line in the raw text, but it is NOT the general subject area, but a SPECIFIC topic. However, do not use the full description as the title.
In the raw text I provided, there may or may not be 1-3 lines of general subject area, which may be the same text repeated, and there may or may not be a full description, but there is definitely a title, on its own line, likely even on its own line with blank lines before and/ or after it. 
Use this for the value of the title property and don't skip parts of the title line. The title should be verbatim as I provided it, even if it contains a colon, even if it is more than one sentence. 
If you think you have found the title, check it is not the general subject area or description and, if it was, then use the title instead.
Discard additional information in the stage, startTime24hr and endTime24hr properties: the times should both be in the format HH:MM, in 24 hour format, with no seconds, day or date; 
and the stage should be just the stage or room, exactly matching one of those strings "Breakout1", "Breakout3", "Mainstage", "Stage1", "Stage2", "Stage3", "Stage4", "Stage5", "Stage6", "ClassroomA", "ClassroomB", "ClassroomC", "ClassroomD", "ClassroomE"
Every event should have a start time and and end time, a title.
If you are considering leaving title, stage, startTime24hr or endTime24hr blank, look at the data again because you have made a mistake. Definitely do not make up these data, though.
Maintain case sensitivity.
After you generate a response, check the JSON object to see if it is in the correct form. If not, try again before sending the reponse.
In particular, take the stage property from your answer and replace it with one of "Breakout1", "Breakout3", "Mainstage", "Stage1", "Stage2", "Stage3", "Stage4", "Stage5", "Stage6", "ClassroomA", "ClassroomB", "ClassroomC", "ClassroomD", "ClassroomE"
If you still cannot find the necessary data in the raw text, then return an object containing the title property and an additional element rawData, which is exactly the raw text I provided.
Here is the raw text:
`;
const storage = {};
const failures = [];
const responses = [];

const httpsAgent = new https.Agent({
  rejectUnauthorized: !(['localhost','127.0.0.1'].includes(urlObj.hostname)),
});
if (!httpsAgent.options.rejectUnauthorized)
  console.log('localhost mode - SSL certificate failures will not prevent fetch');

async function doQuery(prompt) {  
  const response = await fetch(urlObj, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      model,
      prompt,
      format: 'json',
      stream: false,
    }),
    agent: httpsAgent,
  });

  if (logging) 
    console.log(prompt);  

  const resData = await response.json();
  let responseText = (resData && resData.response) ? resData.response.trim() : "";
  if (logging) 
    console.log(responseText);  

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
    this.hasStarted = false; 
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
      if (this.waitingNotifies === 0 && this.hasStarted) {
        this._notifyIdle();
      }
      return;
    }

    this.running = true;
    this.hasStarted = true;
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
    if (this.queue.length === 0 && this.running === false && this.waitingNotifies === 0  && this.hasStarted) {
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

    // If queue is empty and no running task and no more waiting notifications, resolve idle
    if (this.queue.length === 0 && this.running === false && this.waitingNotifies === 0 && this.hasStarted) {
      this._notifyIdle();
    }
  }
}


async function processContent(content, defaultCategory, queue) {
  const defaultCategoryStr = defaultCategory ? ` And if no explicit category in the text, use ${defaultCategory}` : "";
  const queryPrefix = baseQueryPrefix + defaultCategoryStr;

  const sections = content.split(/(\r?\n){3,}/).map(s => s.trim()).filter(Boolean);
  if (defaultCategory)
    console.log(`${defaultCategory.slice(0,2)}: ${defaultCategory} has: `);
  console.log(`${sections.length} sections`);

  for (const [idx, section] of sections.entries()) {
      const prompt = `${queryPrefix}\n${section}`;
      try {
        queue.notifyWaiting(1);
        responses.push (queue.enqueue(() => doQuery(prompt)));
        responses[responses.length -1]
          .then (parsed => {                
            queue.notifyArrived(1);

            // Add fields that will be manually filled in later
            parsed.startSecs = 0;
            parsed.endSecs = 0;

            console.log(`Enqueued query ${defaultCategory.slice(0,2)}${idx}`);
            if (parsed.stage.match(/[\ ,]/)) {
              console.log("You just can't get the staff 🤦");
              console.log(`Got stage="${parsed.stage}". Renaming`);
              parsed.stage = parsed.stage
                .split(',')[0]
                .replace(' ','');
              if (parsed.stage==='MainStage')
                parsed.stage==='Mainstage';
            }
            if (!storage[parsed.stage]) storage[parsed.stage] = [];
            storage[parsed.stage].push(parsed);
          })
      } catch (e) {
        console.log(e);        
        queue.notifyArrived(1);
        failures.push({ query: section, error: String(e), response: e.response, responseJson: e.responseJson });
        console.log("Failure on section:\n", section, "\nError/Response:\n", (e.message || e), "\n");
      }
    }     
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
  console.log(`${responses.length} queries enqueued`);  
  await Promise.all(responses);
  console.log(`${responses.length} responses received`);  

  await fs.writeFile('llm_results.json', JSON.stringify(storage, null, 2));
  await fs.writeFile('llm_failures.json', JSON.stringify(failures, null, 2));
  console.log(`Successes: ${Object.values(storage).flat().length}, Failures: ${failures.length}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
