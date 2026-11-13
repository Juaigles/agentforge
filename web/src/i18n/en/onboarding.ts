// Guided tour (OnboardingTour, GettingStarted and the sidebar). `steps` is the normal script; `yokai`, what changes
// in Yōkai Mode (same tour, different voice).
export default {
  region: 'Guided tour',
  progress: 'Step {n} of {total}',
  announce: 'Guided tour, step {n} of {total}: {title}',
  actions: {
    next: 'Next',
    back: 'Back',
    skip: 'Skip tour',
    close: 'Close the tour (you can resume it later)',
    finish: 'Finish',
    goThere: 'Take me there',
    retry: 'Try again',
    skipToEnd: 'Go to the end of the tour',
    openWorkflow: 'Open the welcome workflow',
  },
  launcher: {
    start: 'Guided tour',
    resume: 'Resume the tour',
    startLong: 'Take the guided tour',
    resumeLong: 'Resume the guided tour ({n} of {total})',
  },
  offer: {
    title: 'First time here?',
    body: 'A tour of a few minutes shows you the app by actually running a sample workflow.',
    updated: 'The guided tour has been updated since last time.',
    start: 'Start the tour',
    later: 'Not now',
  },
  waiting: {
    launch: 'Waiting for you to launch the run…',
    approval: 'Waiting for the run to reach the approval step…',
    finish: 'Waiting for the run to finish…',
  },
  elsewhere: 'This step is shown on another screen.',
  preparing: 'Preparing the welcome workflow…',
  prepareFailed: 'The welcome workflow could not be prepared. Check the connection to the server and try again.',
  noModel: {
    title: 'A model is missing',
    body: 'Running the workflow needs a model that responds, and right now no provider does. The getting started guide on the Dashboard explains how to connect one; once you have it, come back here and carry on.',
    guide: 'Open the getting started guide',
    settings: 'Go to Settings',
  },
  skin: {
    label: 'Choose how you want to see it',
    normal: 'Normal',
    normalHint: 'Plain: panels, graphs and lists.',
    yokai: 'Yōkai Mode',
    yokaiHint: 'A pixel-art office of yōkai.',
    later: 'You can change it any time with the “Yōkai Mode” switch in the sidebar.',
  },
  typewriter: 'Animated text',
  narrator: 'Kitsune, your guide',
  links: {
    title: 'What next',
    createAgent: 'Create your own agent',
    duplicate: 'Duplicate or edit workflows',
    glossary: 'Browse the glossary',
    toYokai: 'Try Yōkai Mode',
    toNormal: 'Back to the normal look',
  },
  steps: {
    welcome: {
      title: 'Welcome to AgentForge',
      body: 'AgentForge orchestrates AI agents and workflows that run on models on your own machine. In this tour you will see the main pieces and run a sample workflow from start to finish.',
    },
    dashboard: {
      title: 'The Dashboard',
      body: 'This is the overview: how many runs are in progress, how many finished well, token usage and the latest activity.',
    },
    agents: {
      title: 'Agents',
      body: 'An agent is a language model with a role, instructions and tools. You can try each one on its own in its playground before using it in a workflow.',
    },
    builder: {
      title: 'The workflow builder',
      body: 'This is the welcome workflow. A workflow is a diagram: each box is a step (a node) and the arrows say in which order they run and which data goes from one to the next. Let’s look at the step types one by one.',
    },
    node: {
      input: {
        title: 'Input',
        body: 'Everything starts here: it takes the text you launch the run with. Other steps refer to it as input between double braces.',
      },
      agent: {
        title: 'Agent',
        body: 'An agent step hands a task to one of your agents, which reasons with the model and may call tools. Its answer is the step’s output.',
      },
      tool: {
        title: 'Tool',
        body: 'Runs a tool directly, with no model: an HTTP request, reading a file, a search… It is fast and uses no tokens.',
      },
      condition: {
        title: 'Condition',
        body: 'Chooses the path: it checks something about the data and continues through the “yes” or the “no” output. Branches not taken are skipped.',
      },
      transform: {
        title: 'Transform',
        body: 'Shapes the data with a template: combines outputs from earlier steps, trims or reformats before moving on.',
      },
      foreach: {
        title: 'For each',
        body: 'Repeats a job for every item in a list (for instance, each line of the input) and gathers the results.',
      },
      approval: {
        title: 'Human approval',
        body: 'The workflow stops here until a person approves or rejects it. Use it to review before doing something important.',
      },
      output: {
        title: 'Output',
        body: 'The end of the road: whatever reaches this step is the result of the run.',
      },
    },
    edges: {
      title: 'Connections',
      body: 'Arrows join a step’s output to the next step’s input. Steps that do not depend on each other run at the same time; a condition has two outputs, one per branch.',
    },
    launch: {
      title: 'Run it',
      body: 'Press “Run”, type an input (any sentence will do) and launch it. The tour carries on by itself once the run starts.',
    },
    runLive: {
      title: 'The run, live',
      body: 'The graph shows the state of each step as it happens: the one working lights up, and the particles travelling along the arrows are the data moving from one step to the next.',
    },
    runSteps: {
      title: 'Steps and activity',
      body: 'On the left, the list of steps with their status and duration; pick one to see its output. The “Activity” tab tells what each agent did: what it thought, which tools it called and what they answered.',
    },
    approval: {
      title: 'Your call',
      body: 'The run has stopped at the human approval. The notice at the top shows up on every screen: read the message, add a comment if you like and press “Approve” to let it continue.',
    },
    result: {
      title: 'Result',
      body: 'Here you have how long it took, how many model and tool calls it made and how many tokens it used. The final result is in the “Result” tab; every run is kept under “Runs”.',
    },
    finish: {
      title: 'All done!',
      body: 'You have seen the whole cycle: design a workflow, run it, follow it live and decide on an approval. You can repeat this tour any time from the sidebar.',
    },
  },
  yokai: {
    welcome: {
      title: 'Welcome to the office!',
      body: 'I am Kitsune and today I will show you around. AgentForge is an office of yōkai: each agent is a staff member working with models on your own machine, and workflows are the jobs that travel from room to room.',
    },
    dashboard: {
      body: 'The noticeboard at the entrance: how many jobs are in progress, how many went well and how much energy (tokens) we have spent.',
    },
    agents: {
      title: 'The staff',
      body: 'Each agent is a yōkai on the staff: it has its post, its instructions and its tools. You can test it in its playground before sending it on a job.',
    },
    builder: {
      title: 'The job’s floor plan',
      body: 'This is the welcome job. Each step type is a room in the office and the arrows are the corridors the data travels along. Let’s walk through the rooms one by one.',
    },
    node: {
      input: { body: 'Reception: the job arrives here with the text you type when you launch it.' },
      agent: { body: 'The cubicles: a yōkai from the staff takes the task, thinks with its model and answers.' },
      tool: { body: 'The server room: a tool is used without any model, fast and with no tokens spent.' },
      condition: { body: 'The lobby: here it is decided which door the job goes through, “yes” or “no”.' },
      transform: { body: 'The printers: the data is reassembled with a template before moving on.' },
      foreach: { body: 'The meeting room: the same job is repeated for each item in a list.' },
      approval: { body: 'The office: the job waits for someone to stamp the hanko seal to approve it, or to reject it.' },
      output: { body: 'The mailroom: whatever gets here leaves the office as the result.' },
    },
    edges: {
      body: 'Corridors link one room to the next. If two rooms do not depend on each other, both are worked on at once; the lobby has two doors, one per path.',
    },
    launch: {
      body: 'Press “Run”, type whatever you like as the job and launch it. As soon as it comes in through reception, I will take you to watch it.',
    },
    runLive: {
      title: 'The floor, live',
      body: 'This is the office seen from above. The ghost courier carries the blue flame (the data) from room to room; each step’s yōkai goes to its cubicle, and the room being worked in lights up.',
    },
    runSwitch: {
      title: 'Floor or graph',
      body: 'This switch toggles between the office floor and the classic step graph. Both show the same thing; pick the one you prefer.',
    },
    runSteps: {
      body: 'On the left, the list of steps; pick one to see what it did. “Activity” holds each yōkai’s diary: what it thought, which tools it used and what they answered.',
    },
    approval: {
      body: 'The job has reached the office and is waiting for your hanko seal. Use the notice at the top (it shows on every screen): press “Approve” to stamp the seal and let the courier carry on.',
    },
    result: {
      body: 'Job delivered. Here you see how long it took, how many times the model and tools were consulted and how much energy (tokens) it used. The result is in the “Result” tab.',
    },
    finish: {
      title: 'Job done!',
      body: 'Now you know the office: design a job, launch it, follow the courier and stamp an approval. Call me again any time from the sidebar.',
    },
  },
};
