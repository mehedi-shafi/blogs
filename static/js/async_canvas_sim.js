function initSimulations() {
    document.querySelectorAll(".async-sim-instance").forEach((root) => {
        if (root.dataset.initialized) return;
        root.dataset.initialized = "true";

        const canvas = root.querySelector(".simCanvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");

        const conf = {
            api: root.querySelector(".slide-api"),
            fleetA: root.querySelector(".slide-fleetA"),
            fleetB: root.querySelector(".slide-fleetB"),
            subtasks: root.querySelector(".slide-subtasks"),
            btime: root.querySelector(".slide-btime"),
            scale: root.querySelector(".slide-scale"),
        };

        const labels = {
            api: root.querySelector(".val-api"),
            fleetA: root.querySelector(".val-fleetA"),
            fleetB: root.querySelector(".val-fleetB"),
            subtasks: root.querySelector(".val-subtasks"),
            btime: root.querySelector(".val-btime"),
            scale: root.querySelector(".val-scale"),
        };

        const controlsExist = conf.api !== null;

        const nodes = {
            entryAPI: {
                x: 50,
                y: 90,
                w: 110,
                h: 50,
                label: "Submissions",
                sub: "Ingress Flow",
            },
            queueA: {
                x: 230,
                y: 90,
                w: 110,
                h: 50,
                label: "Submission Queue",
                sub: "Buffer In",
            },
            workersA: {
                x: 140,
                y: 280,
                w: 160,
                h: 80,
                label: "Backend Async",
                sub: "Polling Hooks",
            },
            rpcB: {
                x: 440,
                y: 280,
                w: 140,
                h: 70,
                label: "RPC Router Target",
                sub: "State Engine",
            },
            queueB: {
                x: 740,
                y: 280,
                w: 110,
                h: 50,
                label: "Sandbox Queue",
                sub: "Subtask Broker",
            },
            workersB: {
                x: 710,
                y: 90,
                w: 160,
                h: 70,
                label: "Sandbox Worker",
                sub: "Compute Cluster",
            },
        };

        let packets = [];
        let queueA_Count = 0;
        let queueB_Pool = [];
        let totalSuccessCount = 0;
        let totalFailureCount = 0;

        let activeJobsA = [];
        let activeWorkersB = [];
        let jobIdSequence = 0;

        let lastTime = 0;
        let apiAccumulator = 0;
        let autoIngressActive = false;

        const playPauseBtn = root.querySelector(".btn-play-pause");
        const statusText = root.querySelector(".status-text");
        const manualBtn = root.querySelector(".btn-manual-dispatch");

        if (controlsExist && playPauseBtn) {
            playPauseBtn.addEventListener("click", () => {
                autoIngressActive = !autoIngressActive;
                if (autoIngressActive) {
                    playPauseBtn.innerText = "Pause Auto Ingress";
                    playPauseBtn.style.background = "#bf616a";
                    if (statusText) statusText.innerText = "AUTO INGRESS: ACTIVE";
                } else {
                    playPauseBtn.innerText = "Play Auto Ingress";
                    playPauseBtn.style.background = "#81a1c1";
                    if (statusText)
                        statusText.innerText = "AUTO INGRESS: OFF (MANUAL ONLY)";
                }
            });
        }

        if (manualBtn) {
            manualBtn.addEventListener("click", () => {
                spawnPacket(
                    nodes.entryAPI,
                    nodes.queueA,
                    "#38bdf8",
                    0.02,
                    0,
                    () => {
                        queueA_Count++;
                    },
                );
            });
        }

        function updateLabels() {
            if (!controlsExist) return;
            if (labels.api) labels.api.innerText = conf.api.value;
            if (labels.fleetA) labels.fleetA.innerText = conf.fleetA.value;
            if (labels.fleetB) labels.fleetB.innerText = conf.fleetB.value;
            if (labels.subtasks) labels.subtasks.innerText = conf.subtasks.value;
            if (labels.btime) labels.btime.innerText = conf.btime.value + "s";
            if (labels.scale) labels.scale.innerText = conf.scale.value + "x";
        }

        function spawnPacket(
            from,
            to,
            color,
            speed = 0.03,
            curve = 0,
            onArrival = null,
        ) {
            packets.push({ from, to, color, progress: 0, speed, curve, onArrival });
        }

        function getBezierPoint(p0, p1, p2, t) {
            return {
                x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
                y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
            };
        }

        function simulationTick(dt) {
            const timeScale = controlsExist ? parseFloat(conf.scale.value) : 10;
            const scaledDt = (dt / 1000) * timeScale;
            const apiRate = controlsExist ? parseInt(conf.api.value) : 1;
            const maxFleetA = controlsExist ? parseInt(conf.fleetA.value) : 50;
            const maxFleetB = controlsExist ? parseInt(conf.fleetB.value) : 5;
            const subtaskTarget = controlsExist ? parseInt(conf.subtasks.value) : 5;
            const bProcessingDuration = controlsExist
                ? parseFloat(conf.btime.value)
                : 25;

            // 1. Auto Ingress
            if (autoIngressActive) {
                apiAccumulator += apiRate * scaledDt;
                if (apiAccumulator >= 1) {
                    let count = Math.floor(apiAccumulator);
                    apiAccumulator -= count;
                    for (let i = 0; i < Math.min(count, 3); i++) {
                        spawnPacket(
                            nodes.entryAPI,
                            nodes.queueA,
                            "#38bdf8",
                            0.02,
                            0,
                            () => {
                                queueA_Count++;
                            },
                        );
                    }
                }
            } else {
                apiAccumulator = 0;
            }

            // 2. Queue A allocation to Fleet A
            while (activeJobsA.length < maxFleetA && queueA_Count > 0) {
                queueA_Count--;
                let jobPlaceholder = {
                    id: ++jobIdSequence,
                    currentSubtask: 1,
                    totalSubtasks: subtaskTarget,
                    state: "transit_to_worker",
                    lastPollTimer: 0,
                    rpcSubmitted: false,
                    subtaskReadyFlag: false,
                    pollCount: 0,
                };
                activeJobsA.push(jobPlaceholder);

                spawnPacket(
                    nodes.queueA,
                    nodes.workersA,
                    "#38bdf8",
                    0.03,
                    0,
                    () => {
                        jobPlaceholder.state = "dispatching";
                    },
                );
            }

            while (activeJobsA.length > maxFleetA) {
                let unstarted = activeJobsA.findIndex(
                    (j) =>
                        j.state === "transit_to_worker" || j.state === "dispatching",
                );
                if (unstarted !== -1) activeJobsA.splice(unstarted, 1);
                else break;
            }

            // 3. Fleet A Operations Engine
            activeJobsA.forEach((job) => {
                if (job.state === "dispatching" && !job.rpcSubmitted) {
                    job.rpcSubmitted = true;
                    job.state = "transit_to_rpc";

                    spawnPacket(
                        nodes.workersA,
                        nodes.rpcB,
                        "#a855f7",
                        0.04,
                        -20,
                        () => {
                            job.state = "polling";
                            job.lastPollTimer = 0;

                            queueB_Pool.push({ parentId: job.id });
                            spawnPacket(nodes.rpcB, nodes.queueB, "#a855f7", 0.03);
                        },
                    );
                } else if (job.state === "polling") {
                    job.lastPollTimer += scaledDt;
                    if (job.lastPollTimer >= 2) {
                        job.lastPollTimer = 0;
                        job.pollCount++;

                        if (job.pollCount > 150) {
                            job.state = "failed";
                            return;
                        }

                        spawnPacket(
                            nodes.workersA,
                            nodes.rpcB,
                            "#f43f5e",
                            0.04,
                            -20,
                            () => {
                                if (job.state === "failed") return;

                                if (job.subtaskReadyFlag) {
                                    job.subtaskReadyFlag = false;
                                    if (job.currentSubtask < job.totalSubtasks) {
                                        job.currentSubtask++;
                                        job.state = "dispatching";
                                        job.rpcSubmitted = false;
                                    } else {
                                        job.state = "complete";
                                    }
                                } else {
                                    spawnPacket(
                                        nodes.rpcB,
                                        nodes.workersA,
                                        "#eab308",
                                        0.04,
                                        20,
                                    );
                                }
                            },
                        );
                    }
                }
            });

            for (let i = activeJobsA.length - 1; i >= 0; i--) {
                if (activeJobsA[i].state === "complete") {
                    activeJobsA.splice(i, 1);
                    totalSuccessCount++;
                    spawnPacket(nodes.workersA, nodes.entryAPI, "#22c55e", 0.02);
                } else if (activeJobsA[i].state === "failed") {
                    queueB_Pool = queueB_Pool.filter(
                        (subtask) => subtask.parentId !== activeJobsA[i].id,
                    );
                    activeJobsA.splice(i, 1);
                    totalFailureCount++;
                    spawnPacket(nodes.workersA, nodes.entryAPI, "#bf616a", 0.02);
                }
            }

            // 4. Parallel Queue B Allocation to Fleet B
            while (activeWorkersB.length < maxFleetB && queueB_Pool.length > 0) {
                let subtask = queueB_Pool.shift();
                let workerSlot = {
                    remainingTime: bProcessingDuration,
                    state: "transit_in",
                    parentId: subtask.parentId,
                };
                activeWorkersB.push(workerSlot);

                spawnPacket(
                    nodes.queueB,
                    nodes.workersB,
                    "#a855f7",
                    0.025,
                    0,
                    () => {
                        workerSlot.state = "processing";
                    },
                );
            }

            for (let i = activeWorkersB.length - 1; i >= 0; i--) {
                let worker = activeWorkersB[i];
                if (worker.state === "processing") {
                    worker.remainingTime -= scaledDt;

                    if (worker.remainingTime <= 0) {
                        activeWorkersB.splice(i, 1);

                        let savedParentId = worker.parentId;
                        spawnPacket(
                            nodes.workersB,
                            nodes.queueB,
                            "#22c55e",
                            0.03,
                            0,
                            () => {
                                spawnPacket(
                                    nodes.queueB,
                                    nodes.rpcB,
                                    "#22c55e",
                                    0.03,
                                    0,
                                    () => {
                                        let targetedJob = activeJobsA.find(
                                            (j) => j.id === savedParentId,
                                        );
                                        if (targetedJob) {
                                            targetedJob.subtaskReadyFlag = true;
                                        }
                                    },
                                );
                            },
                        );
                    }
                }
            }

            const mQ_A = root.querySelector(".m-queueA");
            const mQ_B = root.querySelector(".m-queueB");
            const mPolls = root.querySelector(".m-polls");
            const mSucc = root.querySelector(".m-success");
            const mFail = root.querySelector(".m-fail");

            if (mQ_A) mQ_A.innerText = queueA_Count;
            if (mQ_B) mQ_B.innerText = queueB_Pool.length;
            if (mPolls)
                mPolls.innerText = activeJobsA.filter(
                    (j) => j.state === "polling",
                ).length;
            if (mSucc) mSucc.innerText = totalSuccessCount;
            if (mFail) mFail.innerText = totalFailureCount;
        }

        function drawNode(node) {
            ctx.fillStyle = "#1e222b";
            ctx.strokeStyle = "#3b4252";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(node.x, node.y, node.w, node.h, 6);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#e2e8f0";
            ctx.font = "bold 12px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(node.label, node.x + node.w / 2, node.y + node.h / 2 + 2);

            ctx.fillStyle = "#64748b";
            ctx.font = "10px system-ui, sans-serif";
            ctx.fillText(node.sub, node.x + node.w / 2, node.y + node.h / 2 + 16);
        }

        function drawConnections() {
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(71, 85, 105, 0.2)";

            const links = [
                [nodes.entryAPI, nodes.queueA],
                [nodes.queueA, nodes.workersA],
                [nodes.rpcB, nodes.queueB],
            ];
            links.forEach((p) => {
                ctx.beginPath();
                ctx.moveTo(p[0].x + p[0].w / 2, p[0].y + p[0].h / 2);
                ctx.lineTo(p[1].x + p[1].w / 2, p[1].y + p[1].h / 2);
                ctx.stroke();
            });

            let qbx = nodes.queueB.x + nodes.queueB.w / 2;
            let qby = nodes.queueB.y + nodes.queueB.h / 2;
            let wbx = nodes.workersB.x + nodes.workersB.w / 2;
            let wby = nodes.workersB.y + nodes.workersB.h / 2;

            ctx.beginPath();
            ctx.moveTo(qbx - 15, qby);
            ctx.lineTo(wbx - 15, wby);
            ctx.moveTo(wbx + 15, wby);
            ctx.lineTo(qbx + 15, qby);
            ctx.stroke();

            let ax = nodes.workersA.x + nodes.workersA.w / 2;
            let ay = nodes.workersA.y + nodes.workersA.h / 2;
            let bx = nodes.rpcB.x + nodes.rpcB.w / 2;
            let by = nodes.rpcB.y + nodes.rpcB.h / 2;

            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - 20, bx, by);
            ctx.moveTo(bx, by);
            ctx.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 + 20, ax, ay);
            ctx.stroke();
        }

        function getOffsetLinePoint(from, to, offset, progress) {
            let startX = from.x + from.w / 2 + offset;
            let startY = from.y + from.h / 2;
            let endX = to.x + to.w / 2 + offset;
            let endY = to.y + to.h / 2;
            return {
                x: startX + (endX - startX) * progress,
                y: startY + (endY - startY) * progress,
            };
        }

        function updatePackets() {
            for (let i = packets.length - 1; i >= 0; i--) {
                let p = packets[i];
                p.progress += p.speed;

                if (p.progress >= 1) {
                    if (typeof p.onArrival === "function") {
                        p.onArrival();
                    }
                    packets.splice(i, 1);
                    continue;
                }

                let cx, cy;
                if (p.from === nodes.queueB && p.to === nodes.workersB) {
                    let pt = getOffsetLinePoint(p.from, p.to, -15, p.progress);
                    cx = pt.x;
                    cy = pt.y;
                } else if (p.from === nodes.workersB && p.to === nodes.queueB) {
                    let pt = getOffsetLinePoint(p.from, p.to, 15, p.progress);
                    cx = pt.x;
                    cy = pt.y;
                } else if (p.curve !== 0) {
                    let startX = p.from.x + p.from.w / 2;
                    let startY = p.from.y + p.from.h / 2;
                    let endX = p.to.x + p.to.w / 2;
                    let endY = p.to.y + p.to.h / 2;
                    let ctrlX = (startX + endX) / 2;
                    let ctrlY = (startY + endY) / 2 + p.curve;
                    let pt = getBezierPoint(
                        { x: startX, y: startY },
                        { x: ctrlX, y: ctrlY },
                        { x: endX, y: endY },
                        p.progress,
                    );
                    cx = pt.x;
                    cy = pt.y;
                } else {
                    let startX = p.from.x + p.from.w / 2;
                    let startY = p.from.y + p.from.h / 2;
                    let endX = p.to.x + p.to.w / 2;
                    let endY = p.to.y + p.to.h / 2;
                    cx = startX + (endX - startX) * p.progress;
                    cy = startY + (endY - startY) * p.progress;
                }

                ctx.shadowColor = p.color;
                ctx.shadowBlur = 4;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(cx, cy, 4, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.shadowBlur = 0;
        }

        function mainLoop(timestamp) {
            if (!lastTime) lastTime = timestamp;
            let dt = timestamp - lastTime;
            lastTime = timestamp;

            if (dt > 100) dt = 100;

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            updateLabels();
            simulationTick(dt);
            drawConnections();

            for (let k in nodes) drawNode(nodes[k]);
            updatePackets();

            requestAnimationFrame(mainLoop);
        }

        requestAnimationFrame(mainLoop);
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSimulations);
} else {
    initSimulations();
}
