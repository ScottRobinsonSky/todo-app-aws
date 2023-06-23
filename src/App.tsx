import { Button } from "@mui/material";
import TaskView from "./components/TaskView";

import { AmplifyUser, AuthEventData } from "@aws-amplify/ui";
import { Auth } from "aws-amplify";
import { useCallback, useEffect, useState } from "react";
import uuid4 from "uuid4";
import {
    AccountTask,
    AccountTaskInput,
    CreateAccountInput,
    CreateAccountMutationVariables,
    CreateTaskMutationVariables,
    DeleteTaskInput,
    DeleteTaskMutationVariables,
    Account as GraphQLAccount,
    Task as GraphQLTask,
    ListAccountsQueryVariables,
    ListTasksQueryVariables,
    Subtask as GraphQLSubtask,
    UpdateAccountInput,
    UpdateAccountMutationVariables,
    UpdateTaskInput,
    UpdateTaskMutationVariables,
} from "./API";
import {
    createAccount as createAccountMutation,
    createTask as createTaskMutation,
    deleteTask as deleteTaskMutation,
    updateAccount as updateAccountMutation,
    updateTask as updateTaskMutation,
} from "./graphql/mutations";
import { listAccounts as listAccountsQuery, listTasks as listTasksQuery } from "./graphql/queries";
import { UpdateAccountOptions } from "./types/graphql";
import {
    ensureExactKeys,
    executeGraphQLOperation,
    getNextPosition,
    isKeyOf,
    removeTypenameFromObject,
    removeValuesFromArray,
    userTaskToAccountTask,
} from "./utils";
import { deleteReminderSchedules } from "./utils/scheduler";

interface AppProps {
    signOut: ((data?: AuthEventData | undefined) => void) | undefined;
    user: AmplifyUser | undefined;
}

export default function App(props: AppProps) {
    // TODO: Subscribe account to the Reminder SNS Topic
    const { signOut, user } = props;

    const [isLoading, setIsLoading] = useState<Boolean>(true);
    const [account, setAccount] = useState<GraphQLAccount | undefined>(undefined);
    // NB: According to autogenerated stubs/types should have __typename, but actually doesn't
    const [tasks, setTasks] = useState<Omit<GraphQLTask, "__typename">[]>([]);
    const [tasksOfAccount, setTasksOfAccount] = useState<AccountTask[]>([]);

    const updateAccount = useCallback(
        async (options: UpdateAccountOptions, acc?: GraphQLAccount) => {
            if (!acc) {
                if (!account) throw new Error(`Attempted to update account with no account set`);
                acc = account;
            }

            const nonTaskOptions = Object.fromEntries(
                Object.entries(options).filter(
                    ([k, _]) => !["tasks", "tasksToAdd", "taskIdsToRemove"].includes(k)
                )
            );

            let accountTasksNotBeingRemoved: AccountTask[] | null = null;
            if ("taskIdsToRemove" in options && options.taskIdsToRemove !== undefined) {
                const { taskIdsToRemove } = options;
                accountTasksNotBeingRemoved = tasksOfAccount.filter(
                    accountTask => !taskIdsToRemove.includes(accountTask.task_id)
                );
            }

            const input: Omit<
                Partial<GraphQLAccount> & { sub: string },
                "updatedAt" | "createdAt" | "__typename"
            > = { sub: acc.sub, ...nonTaskOptions };
            if (accountTasksNotBeingRemoved !== null) {
                input["tasks"] = accountTasksNotBeingRemoved;
            }
            if ("tasksToAdd" in options && options.tasksToAdd?.length) {
                input["tasks"] = [...(input["tasks"] ?? tasksOfAccount), ...options.tasksToAdd];
            } else if ("tasks" in options) input["tasks"] = options.tasks;

            const tasksWithoutTypename: AccountTaskInput[] =
                input.tasks?.map(removeTypenameFromObject) ?? [];

            const exactInput: UpdateAccountInput & { tasks?: AccountTask[] } = ensureExactKeys(
                input,
                ["email?", "sub", "is_admin?", "name?", "tasks?", "username?"]
            );
            const exactInputWithCorrectTasks: UpdateAccountInput = { ...exactInput };
            if (exactInput.tasks) {
                exactInputWithCorrectTasks.tasks = tasksWithoutTypename;
            }

            const variables: UpdateAccountMutationVariables = { input: exactInputWithCorrectTasks };
            console.log(`updateAccount Variables: ${JSON.stringify(variables, null, 2)}`);
            await executeGraphQLOperation(updateAccountMutation, variables);
        },
        [account, tasksOfAccount]
    );

    useEffect(() => {
        if (!user) return;

        // Ensure signed in user has an account
        fetchAccounts().then(accounts => {
            Auth.currentAuthenticatedUser({ bypassCache: false }).then(data => {
                const { email, sub, name }: { email: string; sub: string; name: string } =
                    data.attributes;
                const username: string = data.signInUserSession.accessToken.payload.username;
                const groups: string[] | undefined =
                    data.signInUserSession.accessToken.payload["cognito:groups"];

                const userInfo = { email, sub, name, username, groups };
                for (const [key, value] of Object.entries(userInfo)) {
                    if (!key) throw new Error(`Account's ${key} is ${value}`);
                }

                const isAdmin = groups?.length && groups.includes("Admin") ? true : false;

                console.log({ userInfo });

                let userHasAccount = false;
                for (const acc of accounts) {
                    if (acc.sub === userInfo.sub) {
                        userHasAccount = true;
                        setTasksOfAccount(acc.tasks);
                        setAccount(acc);
                        if (+isAdmin !== acc.is_admin) {
                            console.log(
                                `Updating is_admin status of account ${acc.sub} to ${+isAdmin}`
                            );
                            updateAccount({ is_admin: +isAdmin as 0 | 1 }, acc);
                        }
                        break;
                    }
                }

                if (!userHasAccount) {
                    const { groups, ...restOfUserInfo } = userInfo;
                    createAccount({
                        ...restOfUserInfo,
                        tasks: [],
                        is_admin: groups?.length && groups.includes("Admin") ? 1 : 0,
                    }).then(createdAccount => {
                        console.log(
                            `Created website account for cognito user ${
                                userInfo.sub
                            }: ${JSON.stringify(createdAccount, null, 2)}`
                        );
                        if (createdAccount.data?.createAccount)
                            setAccount(createdAccount.data?.createAccount);
                    });
                }
            });
        });
    }, [user]);

    useEffect(() => {
        if (!account) return;

        // Fetch all tasks the signed in user can see
        // TODO: Edit logic so there's no need for duplication within if & else branch to preserve order of execution
        fetchTasks().then(tasksOfUser => {
            console.log(tasksOfUser);
            setTasks(tasksOfUser);

            // NB: This code assumes it's not possible for a task to be in the account (Account table) but not the user (Task table)
            if (tasksOfAccount.length < tasksOfUser.length) {
                // The tasks of the account isn't up-to-date with the tasks table

                const tasksOfUserIdMapping: Record<GraphQLTask["id"], GraphQLTask> =
                    tasksOfUser.reduce((accumulated, userTask) => {
                        return { ...accumulated, [userTask.id]: userTask };
                    }, {});

                const tasksOfAccountIdMapping: Record<
                    AccountTask["task_id"],
                    Omit<AccountTask, "__typename">
                > = tasksOfAccount.reduce((accumulated, accountTask) => {
                    const { __typename, ...accountTaskWithoutTypename } = accountTask;
                    return {
                        ...accumulated,
                        [accountTask.task_id]: accountTaskWithoutTypename,
                    };
                }, {});

                for (const userTaskId of Object.keys(tasksOfUserIdMapping)) {
                    if (!isKeyOf(userTaskId, tasksOfAccountIdMapping)) {
                        // Task is in the task database but not the account database
                        const userTaskAsAccountTask = userTaskToAccountTask(
                            tasksOfUserIdMapping[userTaskId],
                            {
                                // TODO: Change to utilise permissions enum
                                permissions: 1, // admin perms
                                position: getNextPosition(tasksOfAccount),
                            }
                        );
                        tasksOfAccount.push(userTaskAsAccountTask);
                    }
                }
                console.log(
                    `Tasks of account (initialised): ${JSON.stringify(tasksOfAccount, null, 2)}`
                );
                updateAccount({
                    tasks: tasksOfAccount,
                }).then(() => setIsLoading(false));
            } else {
                console.log("Account's tasks are up-to-date with the tasks table.");
                setIsLoading(false);
            }
        });
    }, [account, tasksOfAccount, updateAccount]);

    if (signOut === undefined && user === undefined) {
        return <p>'signOut' and 'user' props are both undefined</p>;
    } else if (signOut === undefined) {
        return <p>'signOut' prop is undefined and user is ${user?.getUsername()}</p>;
    } else if (user === undefined) {
        return <p>'user' is undefined</p>;
    }

    async function createAccount(details: CreateAccountInput, validateIdInPool: boolean = true) {
        // TODO: Ensure there isn't already an account with the id (*appears* to be done automatically)

        if (validateIdInPool) {
            // TODO: Lookup id to ensure it matches a user in the cognito pool
        }

        const variables: CreateAccountMutationVariables = { input: details };
        console.log(`Create Account: ${JSON.stringify(variables, null, 2)}`);
        return executeGraphQLOperation(createAccountMutation, variables);
    }

    async function createTask() {
        // TODO: Create a form for entering task data (title/description)
        if (!account) throw new Error(`Attempted to create a task without an account set in state`);

        const taskId = uuid4();
        console.log(`Creating a task for account '${account.sub}' with id '${taskId}'`);

        // TODO: Validate task

        const createTaskMutationVariables: CreateTaskMutationVariables = {
            input: {
                taskCreated_byId: account.sub,
                id: taskId,
                // FIXME: Figure out why we can't specify reminder ids. Likely setup relations in gql schema wrong
                // reminders: [],
                subtasks: [],
                title: "Test Task #1",
            },
        };
        console.log(createTaskMutationVariables);
        const response = await executeGraphQLOperation(
            createTaskMutation,
            createTaskMutationVariables
        );
        console.log(response);

        const newTask = response.data?.createTask;
        if (!newTask)
            throw new Error(
                `Didn't receive a new task when creating. Response: ${JSON.stringify(
                    response,
                    null,
                    2
                )}`
            );
        setTasks(prevTasks => [...prevTasks, newTask]);

        const newTaskAsAccountTask = userTaskToAccountTask(newTask, {
            permissions: 1,
            position: getNextPosition(tasksOfAccount),
        });
        await updateAccount({
            tasksToAdd: [newTaskAsAccountTask],
        });
        setTasksOfAccount(prevAccountTasks => [...prevAccountTasks, newTaskAsAccountTask]);
    }

    async function deleteAllTasks() {
        if (!tasksOfAccount.length) {
            alert("There's no tasks to delete!");
            return;
        }
        for (const accountTask of tasksOfAccount) {
            await deleteTask({ id: accountTask.task_id }, false);
        }
        await updateAccount({ tasks: [] });
        setTasksOfAccount([]);
    }

    async function deleteTask(input: DeleteTaskInput, callUpdateAccount: boolean = true) {
        if (!account)
            throw new Error(`Attempted to delete task ${input.id} without an account set.`);

        const exactInput = ensureExactKeys(input, ["id"]);
        const variables: DeleteTaskMutationVariables = { input: exactInput };
        const response = await executeGraphQLOperation(deleteTaskMutation, variables);
        console.log(`Deleted task ${exactInput.id}: ${JSON.stringify(response, null, 2)}`);

        const deletedAccountTask = tasksOfAccount.find(
            taskOfAccount => taskOfAccount.task_id === exactInput.id
        );
        if (!deletedAccountTask) {
            console.log(
                "WARNING: Failed to find account task for the deleted task, so unable to recalculate position of remaining tasks"
            );
            if (callUpdateAccount) {
                await updateAccount({ taskIdsToRemove: [exactInput.id] });
            }
            // Delete any outstanding reminders for this task
            await deleteReminderSchedules(exactInput.id);
            return exactInput.id;
        }

        setTasks(prevTasks => prevTasks.filter(task => task.id !== exactInput.id));
        setTasksOfAccount(prevAccountTasks => {
            const newAccountTasks = prevAccountTasks.filter(
                accountTask => accountTask.task_id !== exactInput.id
            );
            newAccountTasks.forEach(
                accountTask =>
                    (accountTask.position -= +(accountTask.position > deletedAccountTask.position))
            );
            if (callUpdateAccount) updateAccount({ tasks: newAccountTasks });
            // Delete any outstanding reminders for this task
            deleteReminderSchedules(exactInput.id);
            return newAccountTasks;
        });
        return exactInput.id;
    }

    async function fetchAccounts(variables: ListAccountsQueryVariables = {}) {
        const response = await executeGraphQLOperation(listAccountsQuery, variables);
        if (response.errors)
            throw new Error(
                `Got unexpected error(s) when fetching tasks: ${JSON.stringify(
                    response.errors,
                    null,
                    2
                )}`
            );

        const accounts = response.data?.listAccounts?.items;
        if (!accounts)
            throw new Error(
                `Received falsey value for accounts from response ${JSON.stringify(
                    response,
                    null,
                    2
                )}`
            );

        // NB: Could be an empty array as that's not falsey in JS/TS
        const filteredAccounts = removeValuesFromArray(accounts, [null]);
        return filteredAccounts;
    }

    async function fetchTasks(variables: ListTasksQueryVariables = {}) {
        const response = await executeGraphQLOperation(listTasksQuery, variables);
        if (response.errors)
            throw new Error(
                `Got unexpected error(s) when fetching tasks: ${JSON.stringify(
                    response.errors,
                    null,
                    2
                )}`
            );

        const tasks = response.data?.listTasks?.items;
        if (!tasks)
            throw new Error(
                `Received falsey value for tasks from response ${JSON.stringify(response, null, 2)}`
            );

        // NB: Could be an empty array as that's not falsey in JS/TS
        const filteredTasks = removeValuesFromArray(tasks, [null]);
        return filteredTasks;
    }

    async function updateTask(
        options: Omit<
            {
                [k in keyof UpdateTaskInput]: k extends "completed_at" | "description"
                    ? UpdateTaskInput[k]
                    : NonNullable<Required<UpdateTaskInput>[k]>;
            },
            "taskCreated_bySub" | "taskCreated_byId"
        >
    ) {
        // TODO: If updating the task title, then update the content of any pending reminders
        const variables: UpdateTaskMutationVariables = { input: options };
        const response = await executeGraphQLOperation(updateTaskMutation, variables);
        if (!response.data?.updateTask)
            throw new Error(
                `Failed to update task ${options.id}: ${JSON.stringify(response, null, 2)}`
            );

        console.log(`Updated task: ${JSON.stringify(response.data.updateTask, null, 2)}`);
        setTasks(oldTasks => {
            return oldTasks.map(oldTask => {
                if (oldTask.id !== options.id) return oldTask;
                return {
                    ...oldTask,
                    ...(Object.fromEntries(
                        Object.entries(options).map(([k, v]) => {
                            return k === "subtasks"
                                ? [
                                      k,
                                      (v as NonNullable<(typeof options)["subtasks"]>).map(
                                          subtask => {
                                              return { ...subtask, __typename: "Subtask" };
                                          }
                                      ) as GraphQLSubtask[],
                                  ]
                                : [k, v];
                        })
                    ) as Omit<GraphQLTask, "__typename" | "created_by">),
                };
            });
        });
        return response.data.updateTask;
    }

    return isLoading || !account ? (
        <>
            <Button
                color="inherit"
                onClick={signOut}
                sx={{
                    backgroundColor: "#1e5a68",
                    height: "fit-content",
                }}
            >
                Sign Out
            </Button>
            <h1>Loading...</h1>
        </>
    ) : (
        <>
            <Button
                color="inherit"
                onClick={signOut}
                sx={{
                    backgroundColor: "#1e5a68",
                    height: "fit-content",
                }}
            >
                Sign Out
            </Button>
            <h1>{account.username}'s Tasks:</h1>
            <Button onClick={deleteAllTasks}>Delete all of account's tasks</Button>
            <Button
                onClick={async () => {
                    if (!tasksOfAccount.length) {
                        alert("There's no tasks to delete!");
                        return;
                    }
                    await deleteTask({ id: tasksOfAccount[0].task_id });
                }}
            >
                Delete next of account's tasks
            </Button>
            <Button
                onClick={async () => {
                    return createTask();
                }}
            >
                Add Task
            </Button>
            <TaskView
                accountSignedIn={account}
                accountTasks={tasksOfAccount}
                setAccountTasks={setTasksOfAccount}
                userTasks={tasks}
                setUserTasks={setTasks}
                updateAccount={updateAccount}
                deleteTask={deleteTask}
                updateTask={updateTask}
            />
        </>
    );
}
