(ns helix.policy.main
  "Entry point.

    java -cp 'lib/*:src' clojure.main -m helix.policy.main            # serve
    java -cp 'lib/*:src' clojure.main -m helix.policy.main --check F  # validate F and exit

  Configuration is by environment, with safe defaults:
    HELIX_POLICY_FILE   policies/helix-default.edn
    HELIX_POLICY_HOST   127.0.0.1   (do not expose this service beyond the kernel's network)
    HELIX_POLICY_PORT   8181        (0 picks a free port and prints it)"
  (:require [clojure.string :as str]
            [helix.policy.rules :as rules]
            [helix.policy.server :as server])
  (:gen-class))

(defn- env [k default] (or (System/getenv k) default))

(defn check [path]
  (try
    (let [p (rules/load-file* path)]
      (println (str "ok " (:version p) " (" (count (:rules p)) " rules)"))
      0)
    (catch clojure.lang.ExceptionInfo e
      (binding [*out* *err*]
        (println (str "invalid policy " path ":"))
        (doseq [m (:problems (ex-data e) [(.getMessage e)])] (println (str "  - " m))))
      1)
    (catch Exception e
      (binding [*out* *err*] (println (str "cannot read " path ": " (.getMessage e))))
      1)))

(defn -main [& args]
  (cond
    (= "--check" (first args))
    (System/exit (if (second args) (check (second args)) (do (binding [*out* *err*] (println "usage: --check FILE")) 2)))

    :else
    (let [file (env "HELIX_POLICY_FILE" "policies/helix-default.edn")
          host (env "HELIX_POLICY_HOST" "127.0.0.1")
          port (parse-long (env "HELIX_POLICY_PORT" "8181"))
          svc (server/start {:policy-file file :host host :port port})]
      (println (str "helix-policy listening on " host ":" (:port svc) " policy=" file))
      (flush)
      (.addShutdownHook (Runtime/getRuntime) (Thread. ^Runnable #(server/stop svc)))
      @(promise))))
