import { backendSuite } from "../../lib/testing/suite.js";
import backend from "./main.js";

backendSuite("memory", backend);
