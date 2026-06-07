+++
title = "A Tale of a Contest Platform - Part 1"
date = "2026-05-25"
+++
## A Tale of a Contest Platform - Part 1

### The agreement and a timeline.

In a warm summar day in 2023, a close senior of mine suddenly called me with an apparent emergency in his tone. The call lasted for 20 minutes and I was pulled into (in my own accord and with excitement) working on a project that would serve the competitive programming community of Bangladesh.

The preface goes like this. The ICPC ruling state that the regional contest needs to be run in a contest hosting platform that is not built for commercial. Previously that platform was [codemarshal](https://algo.codemarshal.org). That platform was shutdown couple of years before for many reasons, and the fact that the system itself was old and could not hold on to massive load a regional contest exerts on it.

We were tasked with building a new shiny platform that takes the old engine (the core execution sandbox) and make a system around it to host such massive regional contests. We would then be improving or creating new sandboxes on the later steps. The timeline was 3 months to ICPC 2023 Dhaka Regional for the first contest for the platform. I say tasked but the team came in voluntarily with no gain in mind and only for the love of the game itself.

I was poised to lead the team and design the system. So I started with a blank system design diagram to design the most stable, always available system that can handle absurd amount of contestants in a contest.

**Spoiler Alert** We did do that back to back in 2024 and 2025 just not the first iteration.

### The design with a black box in the middle

We laid out the foundational design for the system that would handle the contest management, source code submissions, judging flow and ranklist. Essentially a CRUD web application. And with the added requirement of being super reliable, we decided to go microservice route for different components and came up with the following architecture.

{% mermaid() %}
graph TD
    %% Actors
    Contestant((Contestant))
    Judge((Judge))

    %% Components
    SocketPUSH[Socket PUSH]
    WebServer[Web Server]
    API[API]
    Cache[(Cache)]
    CDN[CDN]

    %% Databases
    PostgresMaster[(Postgres Master)]
    PostgresReplica[(Postgres Replica)]
    S3[(AWS S3)]

    %% Async & Processing
    AsyncServices[Async Services]
    Sandbox[Sandbox]
    SES[SES]

    %% Queues & Scaling
    AsyncQueue[Async backend queue]
    SubmissionQueue[Submission QUEUE]
    VerdictQueue[Verdict QUEUE]
    Scaling[scaling]

    %% Relationships
    SocketPUSH -- DJANGO CHANNEL --> Contestant
    AsyncServices -- Submission result --> SocketPUSH

    Contestant <--> WebServer
    Judge <--> WebServer

    WebServer --> API
    WebServer --> CDN

    API -- heavy calculations --> Cache
    Cache --> API

    API --> PostgresMaster
    API -- INVOKE other asyncs --> AsyncServices

    AsyncServices -- Submissions --> PostgresMaster
    PostgresMaster -.-> PostgresReplica

    AsyncServices <--> AsyncQueue
    AsyncServices --> SubmissionQueue
    VerdictQueue -- submission result --> AsyncServices

    SubmissionQueue <--> Scaling
    SubmissionQueue --> Sandbox
    Sandbox --> VerdictQueue

    Sandbox -- output of run --> S3
    S3 -- required files to run tests --> Sandbox

    Contestant -- submission code --> S3
    Judge -- I/O files & code --> S3

    AsyncServices -- send and affirm emails --> SES
    SES -- password reset / contest invitation --> Contestant
    SES --> Judge
{% end %}

This is all very standard event driven asynchronous micorservice architecture that prioritize reliability over complexity. One may obviously say this is unnecessarily complicated for a simple CRUD backend. And they would be correct, it probably was.

Here the sandbox would be the black box that we had to take over from the older system. This sandbox uses a chroot based process isolation mechanism that works roughly like this:

{% mermaid() %}
graph TD
    Backend[Backend]

    subgraph Sandbox RPC
        Add[RPC: add]
        Get[RPC: get]
    end

    Queue[(Sandbox Queue)]

    subgraph Sandbox Instances
        RQ[RQ Workers..n]
        Execute[Execute Code & I/O]
    end

    Backend -- "calls add()" --> Add
    Add -- "enqueues execution" --> Queue

    Queue -- "fetches job" --> RQ
    RQ --> Execute
    Execute -- "stores result" --> Queue

    Backend -- "calls get()" --> Get
    Get -- "retrieves result (polls every 2s)" --> Queue
    
{% end %}

Yes, now you may absolutely scream at this monstricity.

And of course we had to change the backend design to accomodate for this polling mechanism instead of the neat separation between submission queue vs verdict queue.

Once the backend system was somewhat ready, I started reading through the codes of the sandbox to understand what needs to be done to get it up and running. While reading the code, I found out our current system assumption of having a submission queue is not enough where the backend can directly push a submission to be executed, rather it needs to go through the RPC `add()` function. Where it gets added to the sandbox's internal queue for an worker to pick it up.

Which means there are now two async component in the system.

<!--IMAGE DOESN'T WORK NOW FIX LATER-->
{{ image(src="https://media.tenor.com/mg0QH3Ui9-gAAAAe/this-is-getting-out-of-hand-now-there-are-two.png", alt="now there are two of them") }}
