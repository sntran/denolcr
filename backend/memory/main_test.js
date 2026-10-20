import { backendSuite } from "@rfetch/lib/testing/suite";
import backend from "./main.js";

backendSuite("memory", backend, {
  features: {
    copy: true,
    move: true,
    dirMove: true,
    modTime: true,
    setModTime: true,
  },
});
