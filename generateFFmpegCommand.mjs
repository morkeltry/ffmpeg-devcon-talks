import path from 'path';
const basePath = "~/Downloads/devcon";

import { files, day2 } from "./data.mjs";
let day = 'day2';
let target = day2;


const minsToSecs = mmmColonSs => {
    const [mins, secs] = mmmColonSs.split(':');
    return Number(mins*60) + Number(secs);
}

const escapeStringforBash = str => str
    .replace(/([$`'"\\!#&*:|<>?{}[\](); ])/g, '\\$1')
    .replace(/:/g, '\\:');


// uses re-encoding
// 
// function generateFFmpegCommand(slices, inputFile) {
//     const filterComplexParts = slices.map((slice, index) => {
//       return `[0:v]trim=start=${slice.startSecs}:end=${slice.endSecs},setpts=PTS-STARTPTS[v${index}]; ` +
//              `[0:a]atrim=start=${slice.startSecs}:end=${slice.endSecs},asetpts=PTS-STARTPTS[a${index}]`;
//     }).join('; ');
  

//     const safeTitle = slices.map (el=> escapeStringforBash(el.title)); // Escape bash-unsafe characters

//     const mapParts = slices.map((_, index) => `-map "[v${index}]" -map "[a${index}]" ${safeTitle[index]}.mp4`).join(' ');
  
//     return `ffmpeg -i ${inputFile} -filter_complex "${filterComplexParts}" ${mapParts}`;
//   }


// uses stream copy (but generates separate runs if ffpmeg for each talk)

function generateFFmpegCommands(slices, inputFile) {  
// Generate individual FFmpeg commands for stream copying
return slices.map((slice) => {
    const safeTitle = escapeStringforBash(slice.title); // Escape title for Bash
    const titleInQuotes = `$"{slice.title}"`;
    return `ffmpeg -i ${inputFile} -ss ${slice.startSecs} -to ${slice.endSecs} -c:v copy -c:a copy ${safeTitle}.mp4`;
}).join(' && \n');
}

  // Example usage:
  const slices = [
    {
      title: 'Redefined Interactions: Transforming User Experience with Intents',
      stage: 'Classroom A',
      start: 12509,
      end: 12689,
      category: 'Intents'
    },
    {
      title: 'Another Example Slice',
      stage: 'Stage 1',
      start: 500,
      end: 1000,
      category: 'Example'
    }
  ];

  Object.keys(target)
  .forEach(stage => {
    target[stage]
      .filter(talk => Boolean(!talk.indexingFail))
      .forEach(talk => {
        if (!talk.startSecs && talk.startTimeInMins)
          talk.startSecs = minsToSecs(talk.startTimeInMins);
        if (!talk.endSecs && talk.endTimeInMins)
          talk.endSecs = minsToSecs(talk.endTimeInMins);

        if (!talk.startSecs || !talk.endSecs) {
            console.log({ talk });
            throw new Error ("missing start/ end time");
        }
        if (talk.startSecs >= talk.endSecs) {
            console.log({ talk });
            throw new Error ("backwards talk!");
        }

        if (talk.endSecs-talk.startSecs > 3600) {
            console.log("Warn: long talk:",{ talk });
        }
    })

  })

  Object.keys(target)
    .forEach(stage => {      
        // do not escape input filename, if we can enclose it in quotes (cannot do so if using ~)
        // const inputFile = path.join(basePath, files[day][stage]);        
        const inputFile = path.join(basePath, escapeStringforBash(files[day][stage.replace(' ','')]));
        console.log(generateFFmpegCommands(target[stage], inputFile), '&&');  

    })