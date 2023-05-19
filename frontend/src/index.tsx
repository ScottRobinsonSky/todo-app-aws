import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import { Amplify } from "aws-amplify";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import awsExports from "./aws-exports";
import "./App.css";

Amplify.configure(awsExports);

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
    <React.StrictMode>
        <Authenticator signUpAttributes={["email", "phone_number", "name", "zoneinfo"]}>
            {({ signOut, user }) => <App signOut={signOut} user={user} />}
        </Authenticator>
    </React.StrictMode>
);
