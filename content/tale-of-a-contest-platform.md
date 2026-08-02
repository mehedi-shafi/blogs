+++
title = "A Tale of a Contest Platform"
date = "2026-05-25"
+++

### The agreement and a timeline.

In a warm summer day in 2023, a close senior of mine suddenly called me with an apparent urgency in his tone. The call lasted for 20 minutes and I was pulled into (in my own accord and with excitement) working on a project that would serve the competitive programming community of Bangladesh.

ICPC is a very popular (if not the most) event for competitive programming community in Bangladesh. It has established itself as the biggest and the most prestigious event for undergrad students throughout the country attending Computer Science or SWE or other relevant fields of study.

The ICPC ruling state that the regional contest needs to be run in a contest hosting platform that is not built for commercial gains. Previously that platform was [codemarshal](https://algo.codemarshal.org). That platform shutdown couple of years before for many reasons, and the fact that the system itself was old and could not held onto massive load a regional contest exerts on it.

We were tasked with building a new shiny platform that takes the old engine (the core execution sandbox) and make a system around it to host such massive regional contests. We would then be improving or creating new sandbox on a later time. The timeline was 3 months to ICPC 2023 Dhaka Regional for the first contest of the platform. I say tasked but the team came in voluntarily with no gain in mind and only for the love of the game itself. Everyone we onboarded to the team had the common goal of "let's see if we can do a good job or not!".

I was poised to lead the team and design the system. So I started with a blank system design diagram to design the most stable, always available system that can handle the pressure of a country-wide online preliminary contest.

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

This is all very standard event driven asynchronous micorservice architecture that prioritizes reliability over complexity. One may obviously say this is unnecessarily complicated for a simple CRUD backend. And they would be correct, it probably was. But I still stand behind the architecture in the sense that, this system can be scaled individually to handle load across different part of the system.

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

There are many back and forth of submission (source code) and submission related data between backend and sandbox. Backend holds the responsibility of judging (whether the output of the program is acceptable), pulling code and i/o files from block storage and again storing the output of the execution to block storage. So, it is doing effectively everything while the sandbox is only executing the code and sitting pretty. Which means even if the sandbox is very fast to complete its work the entire life-cycle of an execution is very time consuming.

And of course we had to change the backend design to accommodate for this polling mechanism instead of the neat separation between submission queue vs verdict queue. Luckily the backend was already built with a async component in mind. So we had to change the queueing mechanism into 2 separate queue based async worker orchestrator architecture. I have made a **beautiful** graph below.

Once the backend system was somewhat ready, I started reading through the codes of the sandbox to understand what needs to be done to get it up and running. While reading the code, I found out our current system assumption of having a submission queue is not enough where the backend can directly push a submission to be executed, rather it needs to go through the RPC `add()` function. Where it gets added to the sandbox's internal queue for an worker to pick it up.

Which means there are now two asynchronous components in the system.

{{ image(src="/media/images/now_there_are_two_of_them.jpg" caption="now there are two of them") }}


It looks roughly like this. Click on the dispatch button to see the path of one submission made.

{{ async_2_async(oneshot=true) }}

Because we were close to the preliminary contest, we didn't want to rework the sandbox as we already have too much on the plate to host a contest anyways. So we focused more on the backend and stability of everything coming together. Meaning we left the sandbox design as it was and built around it.

So here's our backend code on receiving a submission for judging before the preliminary mock contest. 

```py
# submission route
def post(self):
    # validate and save to database
    submission = self.validated_data.get("submission")
    # create an async job
    create_and_enqueue_submission.delay(submission)

# the async function
@job
def create_and_enqueue_submission(submission: Submission) -> None:
    # get test cases for the submission
    test_cases: list[TestCase] = get_test_cases(submission)

    test_case_results = []
    for test_case in test_cases:
        # rpc request to enqueue the submission in the sandbox
        uuid = sandbox.add(
            get_submission_payload(submission)
        )

        # now we wait
        while True:
          if (result := sandbox.get(uuid = uuid)) is None:
              sleep(2)
              # every two seconds we poll for status for the status 
              # of a test_case execution
        if validate_result(result):
            save_test_case_result(result)
            test_case_results.append(result)
            break
        else:
            # logics for failed test case
            break

    create_verdict_for_submission(test_case_results)
```

So there are bunch of evident problem here that we are already aware of.

- If a test case fails the entire submission fails without any resuming mechanism.
- With code and i/o for all test-cases the payloads can be heavy. And they are being passed over network to and from sandbox and backend.
- Adding even a couple of milliseconds can result upt to many seconds of delay in total.

Anyways, back to the story.

There's usually a mock contest before the main preliminary contest. It is recommended for the contestants to join the contest for various reasons including load-testing the system itself, find some small bugs and fix them beforehand. And it went pretty well. At this point, I should mention I was on a vacation during this time (3 days in for the preliminary round) in another country with limited availability. The team has done absolutely phenomenal job by preparing the backend for the mock and for the preliminary contest during the time. If it weren't for them, either I would have to cancel my trip, or wouldn't be able to delivery the system at all.

So back to the mock contest. It went as well as you can imagine for a system running in production for the first time. There were bunch of bugs. Standing not working, clarification is public forever. On the bright side submissions were working. Main backend seemed stable. No critical crashes, scaling was fine. But looking at the number of submission and rate of submission per minute, we could forsee a lot more to expect.

Here's the back of the head calculation we did for actual preliminary contest.

Team: 2500
User: 2500 x 3 = 7500
Number of problem: 8
Avg number of test cases: 5
Number of submission per minute: 60 (this is a completely out of the thin air number).

Based on this we decided on the scale with 20 worker instance -> 3 sandbox per worker x 20 => 60 sandboxes working. Backend async with similar number of workers. For the API ECS instances, we estimated around 10 would be required during the peak.

> What is this "PEAK"?

In a contest the peak is two point of the contest, ~5 minutes before the contest begins to first 10 minutes of the contest. And the last 10 minutes of the contest. For the first 15~20 minutes it's because contestants are trying to see whether the contest is online, and for to read the problem statements. During this period the 7500 users armed with refresh can reach up to 75000rpm / 120rps quite easily. We have faced even more.

Auto scaling won't work in this scenario because of the sudden burst load balancer cannot finish provisioning new API instance fast enough to handle the incoming floodgate and can results in api pods dying before becoming healthy. We knew this, and we prepared by pre-scaling the backend to max before the load-balancing kicks and gracefully scale down.

> insert image for a request/s graph.

## The Night before Preli

### Current issues at hand

- Standing not working.
- Standing worker deployment process is not defined.
- Execution must follow the order of test case.

We had a good night sleep of 2h on average per person by making last minute fixes, and making dry runs with what we already had. Everything seemed "fine". Calculations felt on point. Nothing to worry.

## And the contest began.

Unlike mock, the Peak we talked about happened during preli. A massive force of ~75000 Requests landed on our load balancer the first minute of the contest. You might be wondering how can 7500 user be making this many requests. Because the contest is once in a year occurance, the entire programming community of Bangladesh usually peeks at the contest at least once during the contest. And some tries to read the problem statements to try them themselves.

Apart from the contestants, coaches, university faculties associated, organizers sums up to this huge number. Even with the pre-scaling some of our instances died due to the pressure and load-balancer scaled up further. It was not the worst thing to happen in the contest. Within 5 minutes of the contest began our backend scaled up and everything was fine, CRUD wise. With this massive influx though, we lost about 500 request with a status code of 500. Not too bad, I would say. Could have been flawless, but not exactly very bad either.

## Things were looking OKAY

Until we hit the one hour mark in the contest. This is where most team made at least one submission. We noticed the Submission backlog was growing. Meaning a lot of submissions were waiting in the state of "RUNNING" or "PENDING". So we don't have enough workers. First what we did was look into whether all workers were live and working so far. And things looked "fine" on the sandbox end. Which means we need to scale up.

## The mistake

Because backend async was the one setting the state of a submission for "PENDING" (waiting to go to sandbox) to "RUNNING" (submission in the sandbox) queue. We made a massive mistake of increasing the number of workers in the async workers from 60 workers to whooping 95 workers. And for a minute we thought it was the right decision, because the queue had less submissions in the "PENDING" state and more in running. Meanwhile we did provission more EC2 instances from AWS to make more sandbox workers. But we never spun up more sandbox worker.

Here's the same simulation for you with some knobs to play around this time. Hit the play auto ingress to start the simulation with original scale of the system. A one submission per second (60 per minute), 50 async workers, 50 sandbox worker etc. And an arbitrary time of 20s to process one test case.

{{ async_2_async() }}

In the current scale you can see the original submission queue keeps on growing because of the total time required to judge a submission with all it's test cases, takes more time than we have workers to process them. But all submissions gets judged successfully eventually.

Now if we simulate our mistake here by increasing the number of workers in the async, keeping the same number of sandbox workers, you'll see the queue goes down slowly which indicates (wrongly) that the solution is working. The bleeding is stopped.

## The result

Eventually, the actual issue hit the surface after about 20 minutes of this, we noticed none were moving out of "RUNNING" state anymore. Uppon investigation we found out it's because all async workers were dying due to timeout. So no submission were reaching verdict, we now know what, but we have no answer to WHY.

By now you're seeing in the simulation that a lot of tasks are failing due to timeout.

Contestants grew frustrated justifiably. And they started submitting even more of what they thought were correct submission (which might as well have been) and loop of failure continued piling up.

We're now into 2h of the contest, and 1h into the incident. We have stopped judging all together. Because we lacked the mechanism to stop everything and start over (for async part at least), things were looking grim already.

By the time we figured out what was the actual issue, it was already too late. The contest was near the end; 3.5h has passed, 80% of the submissions were not judged after more than 2h. Contestants started making fun of us in the public clarification system. Because that was what was working *flawlessly*.

We finished judging all submissions 55 minutes after the contest was concluded.

{{ image(src="/media/images/submission_average_time.png") }}

This graph shows the average time in minutes to judge a submission. And you can see where we shot ourselves in the foot into hours.

## The lesson

They say you gotta take the lesson from your failures. So what did we learn?

### No observability

Our system had no observability. We were blind into every part of the system. We didn't have any metrics, tracings, (centralized logs), error tracking, alerting for anything. So every investigation was jumping blindly into either logs from cloudwatch or numbers from AWS dashboards to go forward with.

We didn't know even if we were slow we were still judging 50 submissions per minute, and if we did absolutely nothing we would be fine. Because the mistake was made during a influx of more submissions per minute than average.

Our system now has detailed observability using opentracing telemetry (traces, metrics etc) in different part of the system. Entire system can be bisected in real time with alerts and dashboards to make decision during contest. This is the first change we made after the contest. Added automated and manual instrumentation. Each component has service level dashboards, business metrics and SLI based alerting.

### Decision before understanding the root cause

We treated the symptom instead of the root cause. And we paid the price in memes and trolls.

{{ video(src="/media/videos/baps_speed.mp4") }}

### Fixing the sandbox data back-and-forth

We updated the sandbox to follow the initial design with message queue for submission and verdict. This resulted in nearly 6x speed up in judging pipeline.

- No more RPC to pass I/O and code between backend and sandbox.
- No more polling inside backend async worker.
- Detailed observability into the sandbox.
- Automated retries backed by DLQ.

{% mermaid() %}
graph TD
    %% Nodes
    A[submissions api]
    B[Submission-queue]
    C["<b>Saber Worker</b><br>[Software System]<br><small>Executes and judges one submission with all test cases in one go.</small>"]
    D[("<b>S3</b><br>[storage: aws s3]<br><small>Pulls Code, I/O files and puts back I/O files</small>")]
    E[Verdict-Queue]
    F[verdict worker]

    %% Connections
    A --> B
    B --> C
    C <--> D
    C --> E
    E --> F

    %% Notes
    G["pulls verdict messages from verdict queue and updates submissions and test cases as they arrives. can be scaled as necessary"]
    G -.- F

    %% Styling
    style C fill:#1d70b8,color:#fff,stroke:#1d70b8
    style D fill:#2b96d1,color:#fff,stroke:#2b96d1
    style A fill:#fff,stroke:#000,rx:10,ry:10
    style F fill:#fff,stroke:#000,rx:10,ry:10
    style B fill:#fff,stroke:#000
    style E fill:#fff,stroke:#000
    style G fill:none,stroke:none
{% end %}

## Conclusion

The initial bapsoj team is now disbanded. We all worked on the project as a side project without any hope for any gains. I do not know how far the platform will support the community in the future, but I do hope the platform stays online and gets more and more people passionate about programming involved.



## Footnote

I have been meaning to pick up writing blogs again. And this has been in my mind for a while to capture this story. This is a mix of both a technical blog and a story. Making the nature of this writing a bit non-continuous on either way. I do apologies for that. Hopefully it will get better with time, and I will pick some writings with some deep dives
