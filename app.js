(function () {
    // Core database state properties
    let lists = [];
    let tasks = [];
    let currentListId = "";
    let filterMode = "all"; // 'all', 'starred', 'completed'
    let isDateSorted = false;

    // Cloud credentials sync parameters
    let cloudEmail = localStorage.getItem("thread_sync_email") || null;
    let cloudKey = localStorage.getItem("thread_sync_key") || null;
    let syncStateMsg = "Local Mode";

    // Temp variables for the Quick Add inputs
    let quickDueDateSelected = null;
    let quickTimeSelected = null;
    let quickRepeatSettingsSelected = {
        type: "NONE",
        limitOccurrences: 5,
        untilDate: null
    };

    // Buffer for selected editing elements
    let editingTaskId = null;
    let editingRepeatSelected = {
        type: "NONE",
        limitOccurrences: 5,
        untilDate: null
    };

    // Helper: secure UUID generator
    function generateUUID() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
        return "web_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    // Helper: SHA-256 for Sync login Key
    async function getSHA256Hash(email, password) {
        const keyRaw = `${email.toLowerCase().trim()}:${password}`;
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(keyRaw);
            const hashBuffer = await crypto.subtle.digest("SHA-256", data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
        } catch (e) {
            // Fallback lightweight hash for compatibility
            let hash = 0;
            for (let i = 0; i < keyRaw.length; i++) {
                hash = (hash << 5) - hash + keyRaw.charCodeAt(i);
                hash |= 0;
            }
            return "user_fallback_" + Math.abs(hash);
        }
    }

    // Initialize Default Lists and State Data if empty
    function loadInitialDatabase() {
        const localData = localStorage.getItem("taskthread_local_db");
        if (localData) {
            try {
                const parsed = JSON.parse(localData);
                lists = parsed.lists || [];
                tasks = parsed.tasks || [];
            } catch (e) {
                console.error("Local database is corrupted, building fresh dataset.", e);
            }
        }

        // Ensure default elements are present
        if (lists.length === 0) {
            const defaultListId = generateUUID();
            lists.push({
                id: defaultListId,
                name: "My Tasks",
                createdAt: Date.now(),
                isDefault: true,
                position: 0
            });
        }

        if (!currentListId) {
            const defaultList = lists.find(l => l.isDefault) || lists[0];
            currentListId = defaultList.id;
        }

        saveToLocalStorage();
    }

    function saveToLocalStorage() {
        const payload = {
            lists: lists,
            tasks: tasks,
            version: 1,
            exportedAt: Date.now()
        };
        localStorage.setItem("taskthread_local_db", JSON.stringify(payload));
    }

    // Show Beautiful Toast Notifications
    function showToast(message, isErr = false) {
        const toast = document.getElementById("toast-notify");
        if (!toast) return;
        toast.textContent = message;
        toast.style.display = "block";
        toast.style.backgroundColor = isErr ? "#ea4335" : "#1a73e8";
        setTimeout(() => {
            toast.style.display = "none";
        }, 3500);
    }

    // Cloud Operations API Interface (CORS Enabled over kvdb)
    async function uploadDatabaseToCloud() {
        if (!cloudKey) return;
        const payload = {
            lists: lists,
            tasks: tasks,
            version: 1,
            exportedAt: Date.now()
        };

        try {
            const response = await fetch(`https://kvdb.io/uDszgY9gGvD77Jshq8yY3m/${cloudKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                console.log("Synchronized to cloud successfully.");
                updateSyncIndicator(true);
            } else {
                showToast("Push sync failed. Will retry.", true);
            }
        } catch (e) {
            console.error(e);
            showToast("Sync server offline. Mode is offline-first.", true);
        }
    }

    async function downloadDatabaseFromCloudAndMerge() {
        if (!cloudKey) return;
        updateSyncIndicator(false, "Syncing...");
        try {
            const response = await fetch(`https://kvdb.io/uDszgY9gGvD77Jshq8yY3m/${cloudKey}`);
            if (response.ok) {
                const cloudPayload = await response.json();
                if (cloudPayload && cloudPayload.lists && cloudPayload.tasks) {
                    mergeDatabases(cloudPayload);
                    showToast("Successfully synchronized with TaskThread Cloud!");
                }
            } else if (response.status === 404) {
                // Key brand new, do initial push
                console.log("New account, committing first cloud dataset.");
                await uploadDatabaseToCloud();
            }
        } catch (e) {
            console.error(e);
            showToast("Failed to fetch cloud sync files.", true);
        } finally {
            updateSyncIndicator(true);
        }
    }

    // Merge algorithm - preserves newer updates on a task-by-task basis
    function mergeDatabases(remote) {
        // 1. Merge lists: replace or insert lists
        remote.lists.forEach(remoteList => {
            const existIndex = lists.findIndex(l => l.id === remoteList.id);
            if (existIndex === -1) {
                lists.push(remoteList);
            } else {
                lists[existIndex] = remoteList;
            }
        });

        // 2. Merge tasks comparing updatedAt fields
        remote.tasks.forEach(remoteTask => {
            const existIndex = tasks.findIndex(t => t.id === remoteTask.id);
            if (existIndex === -1) {
                tasks.push(remoteTask);
            } else {
                const localTask = tasks[existIndex];
                if ((remoteTask.updatedAt || 0) >= (localTask.updatedAt || 0)) {
                    tasks[existIndex] = remoteTask;
                }
            }
        });

        saveToLocalStorage();
        renderSidebar();
        renderTasksFeed();
    }

    function updateSyncIndicator(online, text = null) {
        const indicator = document.getElementById("sync-indicator");
        if (!indicator) return;

        if (online) {
            indicator.textContent = text || "Cloud Synced";
            indicator.className = "sync-pill cloud";
        } else {
            indicator.textContent = text || "Local Mode";
            indicator.className = "sync-pill";
        }
    }

    // Automatic Trigger Save helper
    function triggerSave() {
        saveToLocalStorage();
        if (cloudKey) {
            uploadDatabaseToCloud();
        }
    }

    // UI Render Methods: Sidebar Lists Navigation Drawer
    function renderSidebar() {
        const container = document.getElementById("list-container");
        if (!container) return;
        container.innerHTML = "";

        lists.forEach(lst => {
            const li = document.createElement("li");
            li.className = lst.id === currentListId ? "active" : "";
            li.dataset.id = lst.id;

            const nameBlock = document.createElement("div");
            nameBlock.className = "list-name-block";
            
            const listIcon = document.createElement("span");
            listIcon.className = "material-symbols-outlined";
            listIcon.textContent = lst.id === currentListId ? "folder_open" : "folder";
            listIcon.style.fontSize = "18px";
            nameBlock.appendChild(listIcon);

            const nameSpan = document.createElement("span");
            nameSpan.textContent = lst.name;
            nameBlock.appendChild(nameSpan);

            li.appendChild(nameBlock);

            // Add action tools for custom non-default lists
            if (!lst.isDefault) {
                const actionBlock = document.createElement("div");
                actionBlock.className = "list-actions";

                const editBtn = document.createElement("button");
                editBtn.className = "btn-icon";
                editBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">edit</span>';
                editBtn.onclick = (e) => {
                    e.stopPropagation();
                    const val = prompt("Rename your list:", lst.name);
                    if (val && val.trim()) {
                        lst.name = val.trim();
                        triggerSave();
                        renderSidebar();
                        if (lst.id === currentListId) {
                            document.getElementById("current-list-title").textContent = lst.name;
                        }
                    }
                };

                const delBtn = document.createElement("button");
                delBtn.className = "btn-icon";
                delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px; color:#ea4335;">delete</span>';
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm(`Are you sure you want to delete the "${lst.name}" list? All of its tasks will be permanently removed.`)) {
                        lists = lists.filter(l => l.id !== lst.id);
                        tasks = tasks.filter(t => t.listId !== lst.id);
                        if (currentListId === lst.id) {
                            const remaining = lists.find(l => l.isDefault) || lists[0];
                            currentListId = remaining.id;
                        }
                        triggerSave();
                        renderSidebar();
                        renderTasksFeed();
                    }
                };

                actionBlock.appendChild(editBtn);
                actionBlock.appendChild(delBtn);
                li.appendChild(actionBlock);
            }

            li.onclick = () => {
                currentListId = lst.id;
                document.getElementById("current-list-title").textContent = lst.name;
                document.querySelectorAll(".nav-list li").forEach(el => el.classList.remove("active"));
                li.classList.add("active");
                renderTasksFeed();
            };

            container.appendChild(li);
        });

        // Set the header title based on current list
        const activeLst = lists.find(l => l.id === currentListId);
        if (activeLst) {
            document.getElementById("current-list-title").textContent = activeLst.name;
        }
    }

    // UI Render Methods: Render Tasks Feed List view
    function renderTasksFeed() {
        const container = document.getElementById("tasks-container");
        const emptyState = document.getElementById("tasks-empty-state");
        if (!container || !emptyState) return;

        container.innerHTML = "";

        // Query and filter lists
        let listTasks = tasks.filter(t => t.listId === currentListId);

        if (filterMode === "starred") {
            listTasks = listTasks.filter(t => t.isStarred);
        } else if (filterMode === "completed") {
            listTasks = listTasks.filter(t => t.isCompleted);
        }

        // Parent and subtask separation
        const parents = listTasks.filter(t => !t.parentTaskId);
        const subtasks = listTasks.filter(t => t.parentTaskId);

        // Sorting algorithm
        if (isDateSorted) {
            parents.sort((a, b) => {
                if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
                const dateA = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
                const dateB = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
                return dateA - dateB;
            });
        } else {
            parents.sort((a, b) => {
                if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
                return (b.createdAt || 0) - (a.createdAt || 0); // show newest first
            });
        }

        if (parents.length === 0) {
            emptyState.style.display = "flex";
            container.style.display = "none";
            return;
        }

        emptyState.style.display = "none";
        container.style.display = "flex";

        parents.forEach(task => {
            const card = document.createElement("div");
            card.className = `task-item-card ${task.isCompleted ? 'completed-state' : ''}`;
            card.dataset.id = task.id;

            // Header top row
            const primaryRow = document.createElement("div");
            primaryRow.className = "task-primary-row";

            // Custom dynamic Material 3 checkbox button setup
            const checkbox = document.createElement("div");
            checkbox.className = `m3-checkbox ${task.isCompleted ? 'checked' : ''}`;
            checkbox.innerHTML = '<span class="material-symbols-outlined">check</span>';
            checkbox.onclick = (e) => {
                e.stopPropagation();
                toggleTaskCompleted(task.id);
            };

            const detailsCol = document.createElement("div");
            detailsCol.className = "task-details-col";
            detailsCol.onclick = () => showEditDialog(task.id);

            const title = document.createElement("div");
            title.className = "task-title";
            title.textContent = task.title;

            detailsCol.appendChild(title);

            if (task.details) {
                const desc = document.createElement("div");
                desc.className = "task-desc";
                desc.textContent = task.details;
                detailsCol.appendChild(desc);
            }

            const starBtn = document.createElement("span");
            starBtn.className = `material-symbols-outlined btn-star ${task.isStarred ? 'filled' : ''}`;
            starBtn.textContent = task.isStarred ? "star" : "star_border";
            starBtn.onclick = (e) => {
                e.stopPropagation();
                toggleTaskStarred(task.id);
            };

            primaryRow.appendChild(checkbox);
            primaryRow.appendChild(detailsCol);
            primaryRow.appendChild(starBtn);
            card.appendChild(primaryRow);

            // Badges Indicators Row
            const indicatorsRow = document.createElement("div");
            indicatorsRow.className = "task-indicators";

            if (task.dueDate) {
                const badge = document.createElement("div");
                const deadlineDate = new Date(task.dueDate);
                const isPastDue = deadlineDate < new Date().setHours(0, 0, 0, 0) && !task.isCompleted;
                
                const hasTime = deadlineDate.getHours() !== 12 || deadlineDate.getMinutes() !== 0;
                let formattedDate = deadlineDate.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
                if (hasTime) {
                    const formattedTime = deadlineDate.toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    });
                    formattedDate += ` at ${formattedTime}`;
                }
                
                badge.className = `tag-badge deadline ${isPastDue ? 'past-due' : ''}`;
                badge.innerHTML = `<span class="material-symbols-outlined">calendar_today</span> ${formattedDate}`;
                indicatorsRow.appendChild(badge);
            }

            if (task.repeatType && task.repeatType !== "NONE") {
                const badge = document.createElement("div");
                badge.className = "tag-badge repeat";
                let repText = "Daily";
                if (task.repeatType === "CUSTOM_OCCURRENCES") repText = `Daily × ${task.repeatLimitValue || 5}`;
                else if (task.repeatType === "UNTIL_DATE") {
                    const limitD = task.repeatUntilDate ? new Date(task.repeatUntilDate).toLocaleDateString() : "";
                    repText = `Daily til ${limitD}`;
                }
                badge.innerHTML = `<span class="material-symbols-outlined">repeat</span> ${repText}`;
                indicatorsRow.appendChild(badge);
            }

            // Subtasks badges counter
            const mySubtasks = subtasks.filter(s => s.parentTaskId === task.id);
            if (mySubtasks.length > 0) {
                const completedCount = mySubtasks.filter(s => s.isCompleted).length;
                const badge = document.createElement("div");
                badge.className = "tag-badge";
                badge.innerHTML = `<span class="material-symbols-outlined">subdirectory_arrow_right</span> ${completedCount}/${mySubtasks.length}`;
                indicatorsRow.appendChild(badge);
            }

            if (indicatorsRow.children.length > 0) {
                card.appendChild(indicatorsRow);
            }

            // Check if nested subtasks sub feed exists
            if (mySubtasks.length > 0) {
                const subfeed = document.createElement("div");
                subfeed.className = "subtasks-feed";

                mySubtasks.forEach(sub => {
                    const subItem = document.createElement("div");
                    subItem.className = `subtask-item ${sub.isCompleted ? 'completed-state' : ''}`;

                    const subLeft = document.createElement("div");
                    subLeft.style.display = "flex";
                    subLeft.style.alignItems = "center";
                    subLeft.style.gap = "8px";

                    const subCheck = document.createElement("div");
                    subCheck.className = `m3-checkbox ${sub.isCompleted ? 'checked' : ''}`;
                    subCheck.style.width = "16px";
                    subCheck.style.height = "16px";
                    subCheck.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">check</span>';
                    subCheck.onclick = (e) => {
                        e.stopPropagation();
                        toggleTaskCompleted(sub.id);
                    };

                    const subTitleStr = document.createElement("span");
                    subTitleStr.className = "sub-title";
                    subTitleStr.textContent = sub.title;

                    subLeft.appendChild(subCheck);
                    subLeft.appendChild(subTitleStr);
                    subItem.appendChild(subLeft);

                    const subDel = document.createElement("button");
                    subDel.className = "btn-icon";
                    subDel.style.width = "24px";
                    subDel.style.height = "24px";
                    subDel.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;color:#ea4335;">close</span>';
                    subDel.onclick = (e) => {
                        e.stopPropagation();
                        deleteSingleTask(sub.id);
                    };
                    subItem.appendChild(subDel);

                    subfeed.appendChild(subItem);
                });
                card.appendChild(subfeed);
            }

            container.appendChild(card);
        });
    }

    // Add New Tasks Logic (Supports repeating limits of daily loop)
    function handleAddTask(title, details, dueDate, isStarred, repeatType, limitVal, untilDate) {
        if (!title.trim()) return;

        const newTask = {
            id: generateUUID(),
            listId: currentListId,
            title: title.trim(),
            details: details || null,
            dueDate: dueDate || null,
            isCompleted: false,
            completedAt: null,
            isStarred: isStarred || false,
            parentTaskId: null,
            position: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            repeatType: repeatType || null,
            repeatLimitValue: limitVal || null,
            repeatUntilDate: untilDate || null
        };

        tasks.push(newTask);
        triggerSave();
        renderTasksFeed();
        showToast("Task added successfully!");
    }

    // Toggle Checkmark completion status
    function toggleTaskCompleted(taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        task.isCompleted = !task.isCompleted;
        task.completedAt = task.isCompleted ? Date.now() : null;
        task.updatedAt = Date.now();

        // REPEATING TASKS SPECIAL LOGIC (Recreates the next instance of the loop)
        if (task.isCompleted && task.repeatType && task.repeatType !== "NONE") {
            handleRepeatingProcess(task);
        }

        triggerSave();
        renderTasksFeed();
    }

    function handleRepeatingProcess(task) {
        const curDue = task.dueDate || Date.now();
        const nextDue = curDue + (24 * 60 * 60 * 1000); // add 24 hours

        let nextLimitVal = task.repeatLimitValue;
        let shouldSpawn = true;

        if (task.repeatType === "CUSTOM_OCCURRENCES") {
            const remaining = task.repeatLimitValue || 1;
            if (remaining <= 1) {
                shouldSpawn = false;
            } else {
                nextLimitVal = remaining - 1;
            }
        } else if (task.repeatType === "UNTIL_DATE") {
            const until = task.repeatUntilDate || 0;
            if (nextDue > until) {
                shouldSpawn = false;
            }
        }

        if (shouldSpawn) {
            const spawned = {
                id: generateUUID(),
                listId: task.listId,
                title: task.title,
                details: task.details,
                dueDate: nextDue,
                isCompleted: false,
                completedAt: null,
                isStarred: task.isStarred,
                parentTaskId: task.parentTaskId,
                position: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                repeatType: task.repeatType,
                repeatLimitValue: nextLimitVal,
                repeatUntilDate: task.repeatUntilDate
            };
            tasks.push(spawned);
            showToast("Next instance of repeating task spawned!");
        }
    }

    function toggleTaskStarred(taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;
        task.isStarred = !task.isStarred;
        task.updatedAt = Date.now();
        triggerSave();
        renderTasksFeed();
    }

    function deleteSingleTask(taskId) {
        tasks = tasks.filter(t => t.id !== taskId && t.parentTaskId !== taskId);
        triggerSave();
        renderTasksFeed();
        showToast("Task deleted.");
    }

    // Modal Edit Dialouge Operations and forms bindings
    function showEditDialog(taskId) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        editingTaskId = taskId;

        // Form Fields assignments
        document.getElementById("edit-title").value = task.title;
        document.getElementById("edit-details").value = task.details || "";
        
        if (task.dueDate) {
            const d = new Date(task.dueDate);
            const localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            document.getElementById("edit-due-date").value = localDateStr;
            
            const hasTime = d.getHours() !== 12 || d.getMinutes() !== 0;
            if (hasTime) {
                const localTimeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                document.getElementById("edit-due-time").value = localTimeStr;
            } else {
                document.getElementById("edit-due-time").value = "";
            }
        } else {
            document.getElementById("edit-due-date").value = "";
            document.getElementById("edit-due-time").value = "";
        }
        
        document.getElementById("edit-is-starred").checked = task.isStarred;

        // Draw selection options list dropdown
        const selectList = document.getElementById("edit-list-id");
        selectList.innerHTML = "";
        lists.forEach(l => {
            const opt = document.createElement("option");
            opt.value = l.id;
            opt.textContent = l.name;
            opt.selected = l.id === task.listId;
            selectList.appendChild(opt);
        });

        // Repeat states settings
        editingRepeatSelected = {
            type: task.repeatType || "NONE",
            limitOccurrences: task.repeatLimitValue || 5,
            untilDate: task.repeatUntilDate || null
        };
        updateDlgRepeatUI();

        // Render dialog nested subtasks lists
        renderDialogSubtasks(taskId);

        document.getElementById("dialog-overlay").style.display = "flex";
    }

    function closeDialog() {
        document.getElementById("dialog-overlay").style.display = "none";
        editingTaskId = null;
    }

    function saveDialogChanges() {
        if (!editingTaskId) return;
        const task = tasks.find(t => t.id === editingTaskId);
        if (!task) return;

        const newTitle = document.getElementById("edit-title").value;
        if (!newTitle.trim()) {
            showToast("Title is required", true);
            return;
        }

        task.title = newTitle.trim();
        task.details = document.getElementById("edit-details").value.trim() || null;
        
        const rawDue = document.getElementById("edit-due-date").value;
        const rawTime = document.getElementById("edit-due-time").value;
        if (rawDue) {
            const timeString = rawTime ? `${rawTime}:00` : "12:00:00";
            task.dueDate = new Date(`${rawDue}T${timeString}`).getTime();
        } else {
            task.dueDate = null;
        }
        
        task.isStarred = document.getElementById("edit-is-starred").checked;
        task.listId = document.getElementById("edit-list-id").value;

        // Save repetition settings
        task.repeatType = editingRepeatSelected.type !== "NONE" ? editingRepeatSelected.type : null;
        task.repeatLimitValue = editingRepeatSelected.type === "CUSTOM_OCCURRENCES" ? parseInt(editingRepeatSelected.limitOccurrences) : null;
        task.repeatUntilDate = editingRepeatSelected.type === "UNTIL_DATE" ? editingRepeatSelected.untilDate : null;

        task.updatedAt = Date.now();

        triggerSave();
        closeDialog();
        renderSidebar();
        renderTasksFeed();
        showToast("Task updated!");
    }

    // Repeat selection visual toggles
    function updateDlgRepeatUI() {
        document.querySelectorAll(".dlg-repeat-chip").forEach(btn => {
            const isSel = btn.dataset.val === editingRepeatSelected.type;
            btn.className = `dlg-repeat-chip ${isSel ? 'active' : ''}`;
        });

        document.getElementById("dlg-repeat-limit-box").style.display = editingRepeatSelected.type === "CUSTOM_OCCURRENCES" ? "flex" : "none";
        document.getElementById("dlg-repeat-date-box").style.display = editingRepeatSelected.type === "UNTIL_DATE" ? "flex" : "none";

        document.getElementById("dlg-repeat-occurrences-val").value = editingRepeatSelected.limitOccurrences;
        if (editingRepeatSelected.untilDate) {
            document.getElementById("dlg-repeat-until-val").value = new Date(editingRepeatSelected.untilDate).toISOString().substring(0, 10);
        } else {
            document.getElementById("dlg-repeat-until-val").value = "";
        }
    }

    // Dialog: Subtasks inside dialog editing wrapper
    function renderDialogSubtasks(parentTaskId) {
        const list = document.getElementById("dialog-subtasks-list");
        if (!list) return;
        list.innerHTML = "";

        const kids = tasks.filter(t => t.parentTaskId === parentTaskId);
        kids.forEach(sub => {
            const div = document.createElement("div");
            div.className = "dlg-subtask-item";

            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = sub.isCompleted;
            chk.onchange = () => {
                sub.isCompleted = chk.checked;
                sub.completedAt = sub.isCompleted ? Date.now() : null;
                sub.updatedAt = Date.now();
                triggerSave();
                renderTasksFeed();
            };

            const lbl = document.createElement("span");
            lbl.style.flexGrow = "1";
            lbl.textContent = sub.title;
            if (sub.isCompleted) lbl.style.textDecoration = "line-through";

            const del = document.createElement("button");
            del.className = "btn-icon";
            del.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;color:#ea4335;">delete</span>';
            del.onclick = () => {
                deleteSingleTask(sub.id);
                renderDialogSubtasks(parentTaskId);
            };

            div.appendChild(chk);
            div.appendChild(lbl);
            div.appendChild(del);
            list.appendChild(div);
        });
    }

    function handleAddDialogSubtask() {
        const inp = document.getElementById("new-subtask-title");
        if (!inp || !inp.value.trim() || !editingTaskId) return;

        const val = inp.value.trim();
        const sub = {
            id: generateUUID(),
            listId: currentListId,
            title: val,
            details: null,
            dueDate: null,
            isCompleted: false,
            completedAt: null,
            isStarred: false,
            parentTaskId: editingTaskId,
            position: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            repeatType: null
        };

        tasks.push(sub);
        inp.value = "";
        triggerSave();
        renderDialogSubtasks(editingTaskId);
        renderTasksFeed();
    }

    // Quick Add Bar repetetion settings panel toggle drawer view
    function updateQuickRepeatUI() {
        document.querySelectorAll(".repeat-chip").forEach(btn => {
            const isSel = btn.dataset.val === quickRepeatSettingsSelected.type;
            btn.className = `repeat-chip ${isSel ? 'active' : ''}`;
        });

        document.getElementById("repeat-limit-box").style.display = quickRepeatSettingsSelected.type === "CUSTOM_OCCURRENCES" ? "block" : "none";
        document.getElementById("repeat-date-box").style.display = quickRepeatSettingsSelected.type === "UNTIL_DATE" ? "block" : "none";

        document.getElementById("repeat-occurrences-val").value = quickRepeatSettingsSelected.limitOccurrences;
        if (quickRepeatSettingsSelected.untilDate) {
            document.getElementById("repeat-until-val").value = new Date(quickRepeatSettingsSelected.untilDate).toISOString().substring(0, 10);
        } else {
            document.getElementById("repeat-until-val").value = "";
        }

        const icon = document.getElementById("quick-repeat-icon");
        if (quickRepeatSettingsSelected.type !== "NONE") {
            icon.style.color = "var(--google-green)";
        } else {
            icon.style.color = "inherit";
        }
    }

    // Dom Event Listeners and trigger actions binds
    document.addEventListener("DOMContentLoaded", () => {
        loadInitialDatabase();
        renderSidebar();
        renderTasksFeed();

        // 1. New List Creation Trigger button
        document.getElementById("btn-new-list").onclick = () => {
            const val = prompt("Enter a name for your custom task list:");
            if (val && val.trim()) {
                const name = val.trim();
                const lid = generateUUID();
                lists.push({
                    id: lid,
                    name: name,
                    createdAt: Date.now(),
                    isDefault: false,
                    position: lists.length
                });
                currentListId = lid;
                triggerSave();
                renderSidebar();
                renderTasksFeed();
                showToast(`List "${name}" created.`);
            }
        };

        // 2. Cloud login & connect sync binds
        const emailInp = document.getElementById("cloud-email");
        const passInp = document.getElementById("cloud-pass");
        const loginBtn = document.getElementById("btn-cloud-login");

        loginBtn.onclick = async () => {
            const em = emailInp.value;
            const ps = passInp.value;
            if (!em.trim() || !ps.trim()) {
                showToast("Please enter an Email and password PIN", true);
                return;
            }

            loginBtn.disabled = true;
            loginBtn.textContent = "Connecting...";

            try {
                const hash = await getSHA256Hash(em, ps);
                cloudEmail = em;
                cloudKey = hash;

                localStorage.setItem("thread_sync_email", em);
                localStorage.setItem("thread_sync_key", hash);

                document.getElementById("cloud-logged-out").style.display = "none";
                document.getElementById("cloud-logged-in").style.display = "block";
                document.getElementById("cloud-user-lbl").textContent = em;

                showToast("Logging in. Merging dynamic cloud databases...");
                await downloadDatabaseFromCloudAndMerge();
            } catch (e) {
                console.error(e);
                showToast("Login error.", true);
            } finally {
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<span class="material-symbols-outlined">cloud_sync</span> Login & Pull Sync';
            }
        };

        // Disconnect logout cloud sync binds
        document.getElementById("btn-cloud-logout").onclick = () => {
            if (confirm("Disconnect database sync? No data will be lost offline.")) {
                cloudEmail = null;
                cloudKey = null;
                localStorage.removeItem("thread_sync_email");
                localStorage.removeItem("thread_sync_key");

                document.getElementById("cloud-logged-out").style.display = "block";
                document.getElementById("cloud-logged-in").style.display = "none";
                updateSyncIndicator(false);
                showToast("Sync disconnected.");
            }
        };

        document.getElementById("btn-cloud-pull").onclick = () => downloadDatabaseFromCloudAndMerge();
        document.getElementById("btn-cloud-push").onclick = () => uploadDatabaseToCloud();

        // If credentials are cached, boot into auto sync on load
        if (cloudEmail && cloudKey) {
            document.getElementById("cloud-logged-out").style.display = "none";
            document.getElementById("cloud-logged-in").style.display = "block";
            document.getElementById("cloud-user-lbl").textContent = cloudEmail;
            downloadDatabaseFromCloudAndMerge(); // Pull dynamic database state
        }

        // 3. Manual JSON files export triggers
        document.getElementById("btn-export").onclick = () => {
            const payload = {
                lists: lists,
                tasks: tasks,
                version: 1,
                exportedAt: Date.now()
            };
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload));
            const dlAnchor = document.createElement("a");
            dlAnchor.setAttribute("href", dataStr);
            dlAnchor.setAttribute("download", "taskthread_backup.json");
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            showToast("Backup exported successfully!");
        };

        // Manual JSON files import loader reader
        document.getElementById("file-import").onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const parsed = JSON.parse(evt.target.result);
                    if (parsed.lists && parsed.tasks) {
                        mergeDatabases(parsed);
                        showToast("Manual JSON file imported & merged successfully!");
                    } else {
                        showToast("Invalid file format. Keys missing.", true);
                    }
                } catch (err) {
                    showToast("Failed to parse file JSON.", true);
                }
            };
            reader.readAsText(file);
        };

        // 4. Filters Click binds (Chips)
        document.getElementById("chip-all-tasks").onclick = (e) => {
            document.querySelectorAll(".filter-chip").forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            filterMode = "all";
            renderTasksFeed();
        };

        const starredChip = document.getElementById("chip-starred");
        starredChip.onclick = () => {
            document.querySelectorAll(".filter-chip").forEach(b => b.classList.remove("active"));
            starredChip.classList.add("active");
            filterMode = "starred";
            renderTasksFeed();
        };

        document.getElementById("chip-completed").onclick = (e) => {
            document.querySelectorAll(".filter-chip").forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");
            filterMode = "completed";
            renderTasksFeed();
        };

        // Default Sort Toggle binds
        const btnSort = document.getElementById("btn-toggle-sort");
        const sortIcon = document.getElementById("sort-icon");
        const sortText = document.getElementById("sort-text");

        btnSort.onclick = () => {
            isDateSorted = !isDateSorted;
            if (isDateSorted) {
                sortIcon.textContent = "calendar_today";
                sortText.textContent = "By Date";
            } else {
                sortIcon.textContent = "sort";
                sortText.textContent = "By User";
            }
            renderTasksFeed();
        };

        // 5. Theme toggle buttons click events
        document.querySelectorAll(".theme-btn").forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll(".theme-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                const theme = btn.dataset.theme;
                if (theme === "light") {
                    document.body.className = "slate-light";
                } else {
                    document.body.className = "slate-dark";
                }
            };
        });

        // 6. Quick add task elements inputs triggers
        const quickInput = document.getElementById("task-quick-input");
        const quickSubmit = document.getElementById("btn-quick-submit");

        quickInput.oninput = () => {
            quickSubmit.disabled = !quickInput.value.trim();
        };

        quickSubmit.onclick = () => {
            const val = quickInput.value;
            if (!val.trim()) return;

            handleAddTask(
                val,
                null,
                quickDueDateSelected,
                document.getElementById("quick-star-icon").textContent === "star",
                quickRepeatSettingsSelected.type,
                quickRepeatSettingsSelected.limitOccurrences,
                quickRepeatSettingsSelected.untilDate
            );

            // Clean inputs values
            quickInput.value = "";
            quickSubmit.disabled = true;
            quickDueDateSelected = null;
            quickTimeSelected = null;
            if (document.getElementById("quick-time-picker")) {
                document.getElementById("quick-time-picker").value = "";
            }
            document.querySelectorAll(".time-chip").forEach(c => c.classList.remove("active"));
            if (document.getElementById("quick-time-options-container")) {
                document.getElementById("quick-time-options-container").style.display = "none";
            }
            document.getElementById("quick-date-lbl").style.display = "none";
            document.getElementById("btn-quick-date").classList.remove("active");
            document.getElementById("quick-star-icon").textContent = "star_border";
            quickRepeatSettingsSelected = { type: "NONE", limitOccurrences: 5, untilDate: null };
            updateQuickRepeatUI();
        };

        // Enable user adding items via standard "Enter" keyboard key
        quickInput.onkeydown = (e) => {
            if (e.key === "Enter") {
                quickSubmit.click();
            }
        };

        // Star toggle buttons on quick add toolbar Binders
        const btnQuickStar = document.getElementById("btn-quick-star");
        const starIcon = document.getElementById("quick-star-icon");
        btnQuickStar.onclick = () => {
            const activeStar = starIcon.textContent === "star";
            starIcon.textContent = activeStar ? "star_border" : "star";
            if (!activeStar) {
                btnQuickStar.classList.add("active");
            } else {
                btnQuickStar.classList.remove("active");
            }
        };

        // Quick Date Trigger logic dialog overlay display
        const dateDlg = document.getElementById("quick-date-overlay");
        const datePicker = document.getElementById("quick-date-picker");
        const timeOptionsContainer = document.getElementById("quick-time-options-container");
        const quickTimePickerInput = document.getElementById("quick-time-picker");

        // Setup clock states
        let m3ClockActiveMode = "hour"; // "hour" or "minute"
        let m3ClockHour = 12; // 1-12
        let m3ClockMinute = 0; // 0-59
        let m3ClockAmPm = "AM"; // "AM" or "PM"

        const parse24ToClock = (time24) => {
            if (!time24) {
                m3ClockHour = 12;
                m3ClockMinute = 0;
                m3ClockAmPm = "AM";
                return;
            }
            const parts = time24.split(":");
            let h = parseInt(parts[0], 10) || 0;
            m3ClockMinute = parseInt(parts[1], 10) || 0;

            if (h >= 12) {
                m3ClockAmPm = "PM";
                m3ClockHour = h === 12 ? 12 : h - 12;
            } else {
                m3ClockAmPm = "AM";
                m3ClockHour = h === 0 ? 12 : h;
            }
        };

        const get24FromClock = () => {
            let h = m3ClockHour;
            if (m3ClockAmPm === "PM") {
                if (h !== 12) h += 12;
            } else {
                if (h === 12) h = 0;
            }
            return `${String(h).padStart(2, '0')}:${String(m3ClockMinute).padStart(2, '0')}`;
        };

        const renderM3Clock = () => {
            const numbersContainer = document.getElementById("m3-clock-numbers");
            const clockHand = document.getElementById("m3-clock-hand");
            const hourBtn = document.getElementById("m3-clock-hour-btn");
            const minuteBtn = document.getElementById("m3-clock-minute-btn");
            const amBtn = document.getElementById("m3-ampm-am");
            const pmBtn = document.getElementById("m3-ampm-pm");

            if (!numbersContainer) return;

            // Highlight digital inputs
            if (m3ClockActiveMode === "hour") {
                hourBtn.classList.add("active");
                minuteBtn.classList.remove("active");
            } else {
                hourBtn.classList.remove("active");
                minuteBtn.classList.add("active");
            }

            // Digital labels
            hourBtn.textContent = m3ClockHour;
            minuteBtn.textContent = String(m3ClockMinute).padStart(2, '0');

            // AM/PM state
            if (m3ClockAmPm === "AM") {
                amBtn.classList.add("active");
                pmBtn.classList.remove("active");
            } else {
                amBtn.classList.remove("active");
                pmBtn.classList.add("active");
            }

            // Draw radial numbers
            numbersContainer.innerHTML = "";
            const radius = 72; // px radius

            if (m3ClockActiveMode === "hour") {
                for (let i = 1; i <= 12; i++) {
                    const angleDeg = (i % 12) * 30;
                    const angleRad = angleDeg * (Math.PI / 180);
                    const x = Math.sin(angleRad) * radius;
                    const y = -Math.cos(angleRad) * radius;

                    const numDiv = document.createElement("div");
                    numDiv.className = "m3-clock-number" + (i === m3ClockHour ? " active" : "");
                    numDiv.textContent = i;
                    numDiv.style.left = `calc(50% + ${x}px)`;
                    numDiv.style.top = `calc(50% + ${y}px)`;
                    numbersContainer.appendChild(numDiv);
                }

                const targetAngle = (m3ClockHour % 12) * 30;
                clockHand.style.transform = `rotate(${targetAngle}deg)`;
            } else {
                for (let i = 0; i < 12; i++) {
                    const minuteVal = i * 5;
                    const angleDeg = i * 30;
                    const angleRad = angleDeg * (Math.PI / 180);
                    const x = Math.sin(angleRad) * radius;
                    const y = -Math.cos(angleRad) * radius;

                    const numDiv = document.createElement("div");
                    const isActive = Math.round(m3ClockMinute / 5) * 5 % 60 === minuteVal;
                    numDiv.className = "m3-clock-number" + (isActive ? " active" : "");
                    numDiv.textContent = String(minuteVal).padStart(2, '0');
                    numDiv.style.left = `calc(50% + ${x}px)`;
                    numDiv.style.top = `calc(50% + ${y}px)`;
                    numbersContainer.appendChild(numDiv);
                }

                const targetAngle = m3ClockMinute * 6;
                clockHand.style.transform = `rotate(${targetAngle}deg)`;
            }
        };

        const updateQuickTimeUI = () => {
            document.querySelectorAll(".time-chip").forEach(c => {
                if (quickTimeSelected && c.dataset.time === quickTimeSelected) {
                    c.classList.add("active");
                } else {
                    c.classList.remove("active");
                }
            });
            if (quickTimePickerInput) {
                quickTimePickerInput.value = quickTimeSelected || "";
            }

            parse24ToClock(quickTimeSelected);
            renderM3Clock();
        };

        // Click/drag on Clock Dial handler
        const dial = document.getElementById("m3-clock-dial");
        let isDraggingClock = false;

        const handleClockDialMove = (clientX, clientY) => {
            if (!dial) return;
            const rect = dial.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = clientX - cx;
            const dy = clientY - cy;

            let angleRad = Math.atan2(dx, -dy);
            if (angleRad < 0) angleRad += 2 * Math.PI;
            const angleDeg = angleRad * (180 / Math.PI);

            if (m3ClockActiveMode === "hour") {
                let hour = Math.round(angleDeg / 30);
                if (hour === 0) hour = 12;
                m3ClockHour = hour;
            } else {
                let minute = Math.round(angleDeg / 6) % 60;
                m3ClockMinute = minute;
            }

            quickTimeSelected = get24FromClock();
            
            // Highlight matching quick time chips (if any matches) and update hidden picker input
            document.querySelectorAll(".time-chip").forEach(c => {
                if (c.dataset.time === quickTimeSelected) {
                    c.classList.add("active");
                } else {
                    c.classList.remove("active");
                }
            });
            if (quickTimePickerInput) {
                quickTimePickerInput.value = quickTimeSelected;
            }

            renderM3Clock();
        };

        // Dial Events
        if (dial) {
            dial.onmousedown = (e) => {
                isDraggingClock = true;
                handleClockDialMove(e.clientX, e.clientY);
            };

            window.addEventListener("mousemove", (e) => {
                if (isDraggingClock) {
                    handleClockDialMove(e.clientX, e.clientY);
                }
            });

            window.addEventListener("mouseup", () => {
                if (isDraggingClock) {
                    isDraggingClock = false;
                    if (m3ClockActiveMode === "hour") {
                        setTimeout(() => {
                            m3ClockActiveMode = "minute";
                            renderM3Clock();
                        }, 300);
                    }
                }
            });

            dial.ontouchstart = (e) => {
                if (e.touches && e.touches[0]) {
                    isDraggingClock = true;
                    handleClockDialMove(e.touches[0].clientX, e.touches[0].clientY);
                }
            };

            dial.ontouchmove = (e) => {
                if (isDraggingClock && e.touches && e.touches[0]) {
                    handleClockDialMove(e.touches[0].clientX, e.touches[0].clientY);
                }
            };

            dial.ontouchend = () => {
                if (isDraggingClock) {
                    isDraggingClock = false;
                    if (m3ClockActiveMode === "hour") {
                        setTimeout(() => {
                            m3ClockActiveMode = "minute";
                            renderM3Clock();
                        }, 300);
                    }
                }
            };
        }

        // Digital Interactive Units Binding
        const hourBtn = document.getElementById("m3-clock-hour-btn");
        const minuteBtn = document.getElementById("m3-clock-minute-btn");
        const amBtn = document.getElementById("m3-ampm-am");
        const pmBtn = document.getElementById("m3-ampm-pm");

        if (hourBtn) {
            hourBtn.onclick = () => {
                m3ClockActiveMode = "hour";
                renderM3Clock();
            };
        }
        if (minuteBtn) {
            minuteBtn.onclick = () => {
                m3ClockActiveMode = "minute";
                renderM3Clock();
            };
        }
        if (amBtn) {
            amBtn.onclick = () => {
                m3ClockAmPm = "AM";
                quickTimeSelected = get24FromClock();
                updateQuickTimeUI();
            };
        }
        if (pmBtn) {
            pmBtn.onclick = () => {
                m3ClockAmPm = "PM";
                quickTimeSelected = get24FromClock();
                updateQuickTimeUI();
            };
        }

        document.getElementById("btn-quick-date").onclick = () => {
            let initialDateStr = "";
            if (quickDueDateSelected) {
                const d = new Date(quickDueDateSelected);
                initialDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                
                const hasTime = d.getHours() !== 12 || d.getMinutes() !== 0;
                if (hasTime) {
                    quickTimeSelected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                } else {
                    quickTimeSelected = null;
                }
            } else {
                quickTimeSelected = null;
            }
            
            datePicker.value = initialDateStr;
            m3ClockActiveMode = "hour"; // Reset to selecting hour first
            updateQuickTimeUI();

            if (initialDateStr) {
                timeOptionsContainer.style.display = "block";
            } else {
                timeOptionsContainer.style.display = "none";
            }

            dateDlg.style.display = "flex";

            // Open the calendar popup immediately, programmatically
            setTimeout(() => {
                if (typeof datePicker.showPicker === 'function') {
                    try {
                        datePicker.showPicker();
                    } catch (err) {
                        console.log("Programmatic showPicker failed or not supported context.", err);
                    }
                }
            }, 100);
        };

        // Display time options after date is selected
        datePicker.oninput = () => {
            if (datePicker.value) {
                timeOptionsContainer.style.display = "block";
            } else {
                timeOptionsContainer.style.display = "none";
            }
        };

        // Time chip buttons binding
        document.querySelectorAll(".time-chip").forEach(chip => {
            chip.onclick = () => {
                quickTimeSelected = chip.dataset.time;
                updateQuickTimeUI();
            };
        });

        document.getElementById("btn-quick-date-clear").onclick = () => {
            quickDueDateSelected = null;
            quickTimeSelected = null;
            document.getElementById("quick-date-lbl").style.display = "none";
            document.getElementById("btn-quick-date").classList.remove("active");
            dateDlg.style.display = "none";
        };

        document.getElementById("btn-quick-date-set").onclick = () => {
            const raw = datePicker.value;
            if (raw) {
                const timeStr = quickTimeSelected ? `${quickTimeSelected}:00` : "12:00:00";
                const parsedDate = new Date(`${raw}T${timeStr}`);
                quickDueDateSelected = parsedDate.getTime();
                
                let formatted = parsedDate.toLocaleDateString(undefined, {month: "short", day: "numeric"});
                if (quickTimeSelected) {
                    const formattedTime = parsedDate.toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    });
                    formatted += ` at ${formattedTime}`;
                }
                document.getElementById("quick-date-lbl").textContent = formatted;
                document.getElementById("quick-date-lbl").style.display = "inline";
                document.getElementById("btn-quick-date").classList.add("active");
            } else {
                quickDueDateSelected = null;
                quickTimeSelected = null;
                document.getElementById("quick-date-lbl").style.display = "none";
                document.getElementById("btn-quick-date").classList.remove("active");
            }
            dateDlg.style.display = "none";
        };

        // Close mini overlay outside element clicks
        dateDlg.onclick = (e) => {
            if (e.target === dateDlg) dateDlg.style.display = "none";
        };

        // Quick Repeat Panel drawer toggles
        const repDrawer = document.getElementById("quick-repeat-drawer");
        document.getElementById("btn-quick-repeat").onclick = (e) => {
            e.stopPropagation();
            const isOpen = repDrawer.style.display === "block";
            repDrawer.style.display = isOpen ? "none" : "block";
            updateQuickRepeatUI();
        };

        // Close repeat drawer on apply / body clicks
        document.addEventListener("click", (e) => {
            if (repDrawer.style.display === "block" && !repDrawer.contains(e.target) && e.target.id !== "btn-quick-repeat") {
                repDrawer.style.display = "none";
            }
        });

        // Chips binder events on repeat overlay drawer
        document.querySelectorAll(".repeat-chip").forEach(btn => {
            btn.onclick = () => {
                quickRepeatSettingsSelected.type = btn.dataset.val;
                updateQuickRepeatUI();
            };
        });

        document.getElementById("btn-repeat-save").onclick = () => {
            quickRepeatSettingsSelected.limitOccurrences = parseInt(document.getElementById("repeat-occurrences-val").value) || 5;
            const datesStr = document.getElementById("repeat-until-val").value;
            quickRepeatSettingsSelected.untilDate = datesStr ? new Date(datesStr + "T12:00:00").getTime() : null;
            updateQuickRepeatUI();
            repDrawer.style.display = "none";
        };

        // 7. Dialogue Editing Modals Actions binders
        document.getElementById("btn-close-dialog").onclick = closeDialog;
        document.getElementById("btn-cancel-dialog").onclick = closeDialog;
        document.getElementById("btn-save-dialog").onclick = saveDialogChanges;

        document.getElementById("btn-delete-task").onclick = () => {
            if (editingTaskId && confirm("Do you want to permanently delete this task along with its subtasks?")) {
                deleteSingleTask(editingTaskId);
                closeDialog();
            }
        };

        // Dialogue repeat chips binds
        document.querySelectorAll(".dlg-repeat-chip").forEach(btn => {
            btn.onclick = () => {
                editingRepeatSelected.type = btn.dataset.val;
                updateDlgRepeatUI();
            };
        });

        // Add subtask dialouge click binder trigger
        document.getElementById("btn-add-subtask").onclick = handleAddDialogSubtask;
        document.getElementById("new-subtask-title").onkeydown = (e) => {
            if (e.key === "Enter") handleAddDialogSubtask();
        };

        // Sync local inputs configurations dynamically when modifying repeat limit inside edit dialogue
        document.getElementById("dlg-repeat-occurrences-val").oninput = (e) => {
            editingRepeatSelected.limitOccurrences = e.target.value;
        };
        document.getElementById("dlg-repeat-until-val").oninput = (e) => {
            editingRepeatSelected.untilDate = e.target.value ? new Date(e.target.value + "T12:00:00").getTime() : null;
        };
    });
})();
