import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { ReminderCdkStack } from "./reminder-stack";
import { createCfnOutputs } from "../utils";

export class TodoCDKStack extends Stack {
    public readonly reminderStack: ReminderCdkStack;
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        this.reminderStack = new ReminderCdkStack(this, "ReminderCDKStack");

        const userPool = new cognito.UserPool(this, "TodoAppUserPool", {
            userPoolName: "TodoAppUserPool",
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            advancedSecurityMode: cognito.AdvancedSecurityMode.OFF,
            autoVerify: {
                email: true,
                phone: true,
            },
            deletionProtection: true,
            deviceTracking: {
                challengeRequiredOnNewDevice: true,
                deviceOnlyRememberedOnUserPrompt: true,
            },
            email: cognito.UserPoolEmail.withCognito(),
            keepOriginal: {
                email: true,
                phone: true,
            },
            mfa: cognito.Mfa.OPTIONAL,
            mfaSecondFactor: {
                sms: true, // you can't disable sms
                otp: true,
            },
            passwordPolicy: {
                minLength: 6,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: false,
                tempPasswordValidity: Duration.days(2),
            },
            // If data is transferred to new cognito pool then change to destroy
            removalPolicy: RemovalPolicy.RETAIN,
            selfSignUpEnabled: true,
            signInAliases: {
                email: true,
                phone: false,
                username: true,
            },
            standardAttributes: {
                email: {
                    required: true,
                },
                fullname: {
                    required: true,
                    mutable: false,
                },
                lastUpdateTime: {
                    required: true,
                },
                phoneNumber: {
                    required: true,
                },
                timezone: {
                    required: true,
                },
            },
            userInvitation: {
                emailSubject: "Invite to join our todo app!",
                emailBody:
                    "Hello {username}, you have been invited to join our awesome todo app! Your temporary password is {####}",
                smsMessage:
                    "Hello {username}, your temporary password for our awesome todo app is {####}",
            },
            userVerification: {
                emailSubject: "Verify your email for our todo app",
                emailBody:
                    "Thanks for signing up to our awesome todo app! Your verification code is {####}",
                emailStyle: cognito.VerificationEmailStyle.CODE,
                smsMessage:
                    "Thanks for signing up to our awesome todo app! Your verification code is {####}",
            },
        });

        const userPoolAdminsGroup = new cognito.CfnUserPoolGroup(this, "TodoAppAdminsGroup", {
            userPoolId: userPool.userPoolId,
            description: "A group for admins of the todo application",
            groupName: "Admins",
            precedence: 0, // 0 is the highest possible precedence
        });

        createCfnOutputs(this, {
            reminderStack: this.reminderStack.stackId,
            userPool: userPool.userPoolArn,
            adminsGroup: userPoolAdminsGroup.groupName!,
        });
    }
}
