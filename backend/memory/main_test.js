import { backendSuite } from "@rfetch/lib/testing/suite";
import backend from "./main.js";

backendSuite("memory", backend);
