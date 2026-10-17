import { backendSuite } from "@rfetch/testing/suite";
import backend from "./main.js";

backendSuite("memory", backend);
